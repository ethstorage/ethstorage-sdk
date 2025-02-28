import { ethers } from "ethers";
import {
    BlobUploader,
    stringToHex,
    getChainId,
    encodeOpBlobs
} from "./utils";
import {
    SDKConfig,
    DecodeType,
    CostEstimate,
    ETHSTORAGE_MAPPING,
    BLOB_SIZE,
    OP_BLOB_DATA_SIZE,
    EthStorageAbi,
    BLOB_COUNT_LIMIT,
} from "./param";

export class EthStorage {
    private ethStorageRpc?: string;

    private contractAddr!: string;
    private wallet!: ethers.Wallet;
    private blobUploader!: BlobUploader;

    static async create(config: SDKConfig) {
        const ethStorage = new EthStorage();
        await ethStorage.init(config);
        return ethStorage;
    }

    private async init(config: SDKConfig) {
        const { rpc, privateKey, ethStorageRpc, address } = config;
        this.ethStorageRpc = ethStorageRpc;

        const provider = new ethers.JsonRpcProvider(rpc);
        this.wallet = new ethers.Wallet(privateKey, provider);

        if (address) {
            this.contractAddr = address;
        } else {
            const chainId = await getChainId(rpc);
            this.contractAddr = ETHSTORAGE_MAPPING[chainId];
        }
        if (!this.contractAddr) {
            throw new Error("EthStorage: Network not supported yet.");
        }

        this.blobUploader = await BlobUploader.create(rpc, privateKey);
    }

    async estimateCost(key: string, data: Uint8Array): Promise<CostEstimate> {
        this.checkData(data);
        const hexKey = ethers.keccak256(stringToHex(key));
        const contract = new ethers.Contract(this.contractAddr, EthStorageAbi, this.wallet);
        const [storageCost, maxFeePerBlobGas, gasFeeData] = await Promise.all([
            contract["upfrontPayment"](),
            this.blobUploader.getBlobGasPrice(),
            this.blobUploader.getGasPrice(),
        ]);

        const blobs = encodeOpBlobs(data);
        const blobHash = this.blobUploader.getBlobHash(blobs[0]);
        const gasLimit = await contract["putBlob"].estimateGas(hexKey, 0, data.length, {
            value: storageCost,
            blobVersionedHashes: [blobHash]
        });

        // get cost
        const totalGasCost = (gasFeeData.maxFeePerGas! + gasFeeData.maxPriorityFeePerGas!) * gasLimit;
        const totalBlobGasCost = maxFeePerBlobGas * BigInt(BLOB_SIZE);
        const gasCost = totalGasCost + totalBlobGasCost;
        return {
            storageCost,
            gasCost
        }
    }

    async write(key: string, data: Uint8Array): Promise<{ hexKey: string, success: boolean }> {
        this.checkData(data);

        const contract = new ethers.Contract(this.contractAddr, EthStorageAbi, this.wallet);
        const hexKey = ethers.keccak256(stringToHex(key));
        try {
            const storageCost = await contract["upfrontPayment"]();
            const tx = await contract["putBlob"].populateTransaction(hexKey, 0, data.length, {
                value: storageCost,
            });

            const blobs = encodeOpBlobs(data);
            const txRes = await this.blobUploader.sendTx(tx, blobs);
            console.log(`EthStorage: Tx hash is ${txRes.hash}`);
            const receipt = await txRes.wait();
            return { hexKey, success: receipt?.status === 1 };
        } catch (e) {
            console.error(`EthStorage: Write blob failed!`, (e as Error).message);
        }
        return { hexKey, success: false };
    }

    async read(key: string, decodeType = DecodeType.OptimismCompact): Promise<Uint8Array> {
        if (!key) {
            throw new Error(`EthStorage: Invalid key.`);
        }
        if (!this.ethStorageRpc) {
            throw new Error(`EthStorage: Reading content requires providing 'ethStorageRpc'.`);
        }
        const hexKey = ethers.keccak256(stringToHex(key));
        const provider = new ethers.JsonRpcProvider(this.ethStorageRpc);
        const contract = new ethers.Contract(this.contractAddr, EthStorageAbi, provider) as any;
        const size = await contract.size(hexKey, {
            from: this.wallet.address
        });
        if (size === 0n) {
            throw new Error(`EthStorage: There is no data corresponding to key ${key} under wallet address ${this.wallet.address}.`);
        }
        const data = await contract.get(hexKey, decodeType, 0, size, {
            from: this.wallet.address
        });
        return ethers.getBytes(data);
    }

    async writeBlobs(keys: string[], dataBlobs: Uint8Array[]): Promise<{ hexKeys: string[], success: boolean }> {
        if (!keys || !dataBlobs) {
            throw new Error(`EthStorage: Invalid parameter.`);
        }
        if (keys.length !== dataBlobs.length) {
            throw new Error(`EthStorage: The number of keys and data does not match.`);
        }
        if (keys.length > BLOB_COUNT_LIMIT) {
            throw new Error(`EthStorage: The count exceeds the maximum blob limit.`);
        }

        const blobLength = keys.length;
        const blobArr = [];
        const keyArr = [];
        const idArr = [];
        const lengthArr = [];
        for (let i = 0; i < blobLength; i++) {
            const data = dataBlobs[i];
            this.checkData(data);
            const blob = encodeOpBlobs(data);
            blobArr.push(blob[0]);
            keyArr.push(ethers.keccak256(stringToHex(keys[i])));
            idArr.push(i);
            lengthArr.push(data.length);
        }

        const contract = new ethers.Contract(this.contractAddr, EthStorageAbi, this.wallet);
        try {
            const storageCost = await contract["upfrontPayment"]();
            const tx = await contract["putBlobs"].populateTransaction(keyArr, idArr, lengthArr, {
                value: storageCost * BigInt(blobLength),
            });

            const txRes = await this.blobUploader.sendTx(tx, blobArr);
            console.log(`EthStorage: Tx hash is ${txRes.hash}`);
            const receipt = await txRes.wait();
            return { hexKeys: keyArr, success: receipt?.status === 1 };
        } catch (e) {
            console.error(`EthStorage: Put blobs failed!`, (e as Error).message);
        }
        return { hexKeys: keyArr, success: false };
    }

    checkData(data: Uint8Array | null): void {
        if (!data) {
            throw new Error(`EthStorage: Invalid data.`);
        }
        if (data.length === 0 || data.length > OP_BLOB_DATA_SIZE) {
            throw new Error(`EthStorage: the length of data(Uint8Array) should be > 0 && <= ${OP_BLOB_DATA_SIZE}.`);
        }
    }
}
