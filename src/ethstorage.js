import {ethers} from "ethers";
import {
    BlobUploader,
    stringToHex,
    getChainId,
    EncodeBlobs
} from "./utils";
import {
    ETHSTORAGE_MAPPING,
    BLOB_DATA_SIZE,
    BLOB_SIZE,
    EthStorageAbi
} from "./param";

export class EthStorage {
    #ethStorageRpc;
    #contractAddr;

    #wallet;
    #blobUploader;

    static async create(config) {
        const {rpc, ethStorageRpc, privateKey} = config;
        const chainId = await getChainId(rpc);
        const ethStorageAddress = ETHSTORAGE_MAPPING[chainId];
        if (!ethStorageAddress) {
            throw new Error("EthStorage: Network not supported yet.");
        }

        return new EthStorage(rpc, ethStorageRpc, privateKey, ethStorageAddress);
    }

    constructor(rpc, ethStorageRpc, privateKey, ethStorageAddress) {
        this.#ethStorageRpc = ethStorageRpc;
        this.#contractAddr = ethStorageAddress;

        const provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(privateKey, provider);
        this.#blobUploader = new BlobUploader(rpc, privateKey);
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

        const blobs = EncodeBlobs(data);
        const blobHash = await this.#blobUploader.getBlobHash(blobs[0]);
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
        const storageCost = await contract.upfrontPayment();
        const tx = await contract.putBlob.populateTransaction(hexKey, 0, data.length, {
            value: storageCost,
        });

        const blobs = EncodeBlobs(data);
        let txRes = await this.#blobUploader.sendTx(tx, blobs);
        console.log(`EthStorage: Send Success! hash is ${txRes.hash}`)
        txRes = await txRes.wait();
        return txRes.status;
    }

    async read() {

    }

    async putBlobs(number, data) {
        if (!data || !Buffer.isBuffer(data)) {
            throw new Error(`EthStorage: Invalid data.`);
        }

        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        const storageCost = await contract.upfrontPayment();
        const tx = await contract.putBlobs.populateTransaction(number, {
            value: storageCost * BigInt(number),
        });

        const blobs = EncodeBlobs(data);
        let txRes = await this.#blobUploader.sendTx(tx, [blobs[0]]);
        console.log(`EthStorage: Send Success! hash is ${txRes.hash}`)
        txRes = await txRes.wait();
        return txRes.status;
    }
}
