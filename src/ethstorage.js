import {ethers} from "ethers";
import {
    BlobUploader,
    stringToHex,
    getChainId,
    encodeOpBlobs
} from "./utils";
import {
    ETHSTORAGE_MAPPING,
    BLOB_SIZE,
    OP_BLOB_DATA_SIZE,
    OptimismCompact,
    EthStorageAbi,
    BLOB_COUNT_LIMIT
} from "./param";

export class EthStorage {
    #ethStorageRpc;
    #contractAddr;

    #wallet;
    #blobUploader;

    static async create(config) {
        const {rpc, address} = config;
        const ethStorage = new EthStorage(config);
        await ethStorage.init(rpc, address);
        return ethStorage;
    }

    constructor(config) {
        const {rpc, ethStorageRpc, privateKey} = config;
        this.#ethStorageRpc = ethStorageRpc;

        const provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(privateKey, provider);
        this.#blobUploader = new BlobUploader(rpc, privateKey);
    }

    async init(rpc, address) {
        if (address != null) {
            this.#contractAddr = address;
        } else {
            const chainId = await getChainId(rpc);
            this.#contractAddr = ETHSTORAGE_MAPPING[chainId];
        }
        if (!this.#contractAddr) {
            throw new Error("EthStorage: Network not supported yet.");
        }

        await this.#blobUploader.init();
    }

    async estimateCost(key, data) {
        this.#checkData(data);
        const hexKey = ethers.keccak256(stringToHex(key));
        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        const [storageCost, maxFeePerBlobGas, gasFeeData] = await Promise.all([
            contract.upfrontPayment(),
            this.#blobUploader.getBlobGasPrice(),
            this.#blobUploader.getGasPrice(),
        ]);

        const blobs = encodeOpBlobs(data);
        const blobHash = this.#blobUploader.getBlobHash(blobs[0]);
        const gasLimit = await contract.putBlob.estimateGas(hexKey, 0, data.length, {
            value: storageCost,
            blobVersionedHashes: [blobHash]
        });

        // get cost
        const totalGasCost = (gasFeeData.maxFeePerGas + gasFeeData.maxPriorityFeePerGas) * gasLimit;
        const totalBlobGasCost = maxFeePerBlobGas * BigInt(BLOB_SIZE);
        const gasCost = totalGasCost + totalBlobGasCost;
        return {
            storageCost,
            gasCost
        }
    }

    async write(key, data) {
        this.#checkData(data);

        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        const hexKey = ethers.keccak256(stringToHex(key));
        try {
            const storageCost = await contract.upfrontPayment();
            const tx = await contract.putBlob.populateTransaction(hexKey, 0, data.length, {
                value: storageCost,
            });

            const blobs = encodeOpBlobs(data);
            let txRes = await this.#blobUploader.sendTx(tx, blobs);
            console.log(`EthStorage: Tx hash is ${txRes.hash}`)
            txRes = await txRes.wait();
            return txRes.status;
        } catch (e) {
            console.error(`EthStorage: Write blob failed!`, e.message);
        }
        return false;
    }

    async read(key, decodeType = OptimismCompact) {
        if (!key) {
            throw new Error(`EthStorage: Invalid key.`);
        }
        if(!this.#ethStorageRpc) {
            throw new Error(`EthStorage: Reading content requires providing 'ethStorageRpc'.`)
        }
        const hexKey = ethers.keccak256(stringToHex(key));
        const provider = new ethers.JsonRpcProvider(this.#ethStorageRpc);
        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, provider);
        const size = await contract.size(hexKey, {
            from: this.#wallet.address
        });
        if (size === 0n) {
            throw new Error(`EthStorage: There is no data corresponding to key ${key} under wallet address ${this.#wallet.address}.`)
        }
        const data = await contract.get(hexKey, decodeType, 0, size, {
            from: this.#wallet.address
        });
        return ethers.getBytes(data);
    }

    async writeBlobs(keys, dataBlobs) {
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
            this.#checkData(data);
            const blob = encodeOpBlobs(data);
            blobArr.push(blob[0]);
            keyArr.push(ethers.keccak256(stringToHex(keys[i])));
            idArr.push(i);
            lengthArr.push(data.length);
        }

        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        try {
            const storageCost = await contract.upfrontPayment();
            const tx = await contract.putBlobs.populateTransaction(keyArr, idArr, lengthArr, {
                value: storageCost * BigInt(blobLength),
            });

            let txRes = await this.#blobUploader.sendTx(tx, blobArr);
            console.log(`EthStorage: Tx hash is ${txRes.hash}`);
            txRes = await txRes.wait();
            return txRes.status;
        } catch (e) {
            console.error(`EthStorage: Put blobs failed!`, e.message);
        }
        return false;
    }

    #checkData(data) {
        if (!data || !(data instanceof Uint8Array)) {
            throw new Error(`EthStorage: Invalid data.`);
        }
        if (data.length === 0 || data.length > OP_BLOB_DATA_SIZE) {
            throw new Error(`EthStorage: the length of data(Uint8Array) should be > 0 && < ${OP_BLOB_DATA_SIZE}.`);
        }
    }
}
