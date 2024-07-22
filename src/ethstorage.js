import {ethers} from "ethers";
import {
    BlobUploader,
    stringToHex,
    getChainId,
    encodeBlobs
} from "./utils";
import {
    ETHSTORAGE_MAPPING,
    BLOB_DATA_SIZE,
    BLOB_SIZE,
    PaddingPer31Bytes,
    EthStorageAbi
} from "./param";

export class EthStorage {
    #ethStorageRpc;
    #contractAddr;

    #wallet;
    #blobUploader;

    static async create(config) {
        const {rpc, contractAddr} = config;
        const ethStorage = new EthStorage(config);
        await ethStorage.init(rpc, contractAddr);
        return ethStorage;
    }

    constructor(config) {
        const {rpc, ethStorageRpc, privateKey} = config;
        this.#ethStorageRpc = ethStorageRpc;

        const provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(privateKey, provider);
        this.#blobUploader = new BlobUploader(rpc, privateKey);
    }

    async init(rpc, contractAddr) {
        if (contractAddr != null) {
            this.#contractAddr = contractAddr;
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
        if (!data || !Buffer.isBuffer(data)) {
            throw new Error(`EthStorage: Invalid data.`);
        }
        if (data.length < 0 || data.length > BLOB_DATA_SIZE) {
            throw new Error(`EthStorage: the length of data(Buffer) should be > 0 && < ${BLOB_DATA_SIZE}.`);
        }

        const hexKey = ethers.keccak256(stringToHex(key));
        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        const [storageCost, maxFeePerBlobGas, gasFeeData] = await Promise.all([
            contract.upfrontPayment(),
            this.#blobUploader.getBlobGasPrice(),
            this.#blobUploader.getGasPrice(),
        ]);

        const blobs = encodeBlobs(data);
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
        if (!data || !Buffer.isBuffer(data)) {
            throw new Error(`EthStorage: Invalid data.`);
        }
        if (data.length < 0 || data.length > BLOB_DATA_SIZE) {
            throw new Error(`EthStorage: the length of data(Buffer) should be > 0 && < ${BLOB_DATA_SIZE}.`);
        }

        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        const hexKey = ethers.keccak256(stringToHex(key));
        try {
            const storageCost = await contract.upfrontPayment();
            const tx = await contract.putBlob.populateTransaction(hexKey, 0, data.length, {
                value: storageCost,
            });

            const blobs = encodeBlobs(data);
            let txRes = await this.#blobUploader.sendTx(tx, blobs);
            console.log(`EthStorage: Tx hash is ${txRes.hash}`)
            txRes = await txRes.wait();
            return txRes.status;
        } catch (e) {
            console.error(`EthStorage: Write blob failed!`, e.message);
        }
        return false;
    }

    async read(key) {
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
        const data = await contract.get(hexKey, PaddingPer31Bytes, 0, size, {
            from: this.#wallet.address
        });
        return ethers.getBytes(data);
    }

    async putBlobs(number, data) {
        if (!data || !Buffer.isBuffer(data)) {
            throw new Error(`EthStorage: Invalid data.`);
        }

        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        try {
            const storageCost = await contract.upfrontPayment();
            const tx = await contract.putBlobs.populateTransaction(number, {
                value: storageCost * BigInt(number),
            });

            const blobs = encodeBlobs(data);
            let txRes = await this.#blobUploader.sendTx(tx, [blobs[0]]);
            console.log(`EthStorage: Tx hash is ${txRes.hash}`)
            txRes = await txRes.wait();
            return txRes.status;
        } catch (e) {
            console.error(`EthStorage: Put blobs failed!`, e.message);
        }
        return false;
    }
}
