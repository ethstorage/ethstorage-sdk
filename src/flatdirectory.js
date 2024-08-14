import {ethers} from "ethers";
import {
    BLOB_SIZE,
    DEFAULT_BLOB_DATA_SIZE,
    ETHSTORAGE_MAPPING,
    FlatDirectoryAbi,
    FlatDirectoryBytecode,
    MAX_BLOB_COUNT,
    UPLOAD_TYPE_BLOB,
    UPLOAD_TYPE_CALLDATA,
} from './param';
import {
    BlobUploader, encodeBlobs,
    getChainId, getFileChunk, getHash,
    isBuffer, isFile,
    stringToHex
} from "./utils";

import workerpool from 'workerpool';
const pool = workerpool.pool(__dirname + '/worker.cjs.js');

const REMOVE_FAIL = -1;
const REMOVE_NORMAL = 0;
const REMOVE_SUCCESS = 1;

const GALILEO_CHAIN_ID = 3334;

const defaultCallback = {
    onProgress: () => {
    },
    onFail: () => {
    },
    onFinish: () => {
    }
}

export class FlatDirectory {
    #ethStorageRpc;
    #contractAddr;
    #chainId;
    #isSupportBlob;

    #wallet;
    #blobUploader;

    static async create(config) {
        const {rpc, address} = config;
        const flatDirectory = new FlatDirectory(config);
        await flatDirectory.init(rpc, address);
        return flatDirectory;
    }

    constructor(config) {
        const {rpc, ethStorageRpc, privateKey, address} = config;
        this.#ethStorageRpc = ethStorageRpc;
        this.#contractAddr = address;

        const provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(privateKey, provider);
        this.#blobUploader = new BlobUploader(rpc, privateKey);
    }

    async init(rpc, address) {
        await this.#blobUploader.init();
        this.#chainId = await getChainId(rpc);
        // checkout support blob
        if (address) {
            const provider = new ethers.JsonRpcProvider(rpc);
            const fileContract = new ethers.Contract(address, FlatDirectoryAbi, provider);
            this.#isSupportBlob = await fileContract.isSupportBlob();
        }
    }

    checkAddress() {
        if (!this.#contractAddr) {
            throw new Error(`FlatDirectory: FlatDirectory not deployed!`);
        }
    }

    async deploy() {
        this.#isSupportBlob = ETHSTORAGE_MAPPING[this.#chainId] != null;
        const ethStorage = ETHSTORAGE_MAPPING[this.#chainId] || '0x0000000000000000000000000000000000000000';
        const factory = new ethers.ContractFactory(FlatDirectoryAbi, FlatDirectoryBytecode, this.#wallet);
        try {
            const contract = await factory.deploy(0, DEFAULT_BLOB_DATA_SIZE, ethStorage, {gasLimit: 3800000});
            await contract.waitForDeployment();

            this.#contractAddr = await contract.getAddress();
            console.log(`FlatDirectory: Address is ${this.#contractAddr}`);
            return this.#contractAddr;
        } catch (e) {
            console.error(`FlatDirectory: Deploy FlatDirectory failed!`, e.message);
            return null;
        }
    }

    async setDefault(filename) {
        this.checkAddress();

        const hexName = filename ? stringToHex(filename) : "0x";
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        try {
            const tx = await fileContract.setDefault(hexName);
            console.log(`FlatDirectory: Tx hash is ${tx.hash}`);
            const txReceipt = await tx.wait();
            return txReceipt.status;
        } catch (e) {
            console.error(`FlatDirectory: Set default file failed!`, e.message);
        }
        return false;
    }

    async remove(key) {
        this.checkAddress();

        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        try {
            const tx = await fileContract.remove(stringToHex(key));
            console.log(`FlatDirectory: tx hash is ${tx.hash}`);
            const receipt = await tx.wait();
            return receipt.status;
        } catch (e) {
            console.error(`FlatDirectory: Failed to remove file: ${key}`, e.message);
        }
        return false;
    }

    async download(key, cb = defaultCallback) {
        this.checkAddress();
        if (!this.#ethStorageRpc) {
            throw new Error(`FlatDirectory: Reading content requires providing 'ethStorageRpc'.`);
        }

        const hexName = stringToHex(key);
        const provider = new ethers.JsonRpcProvider(this.#ethStorageRpc);
        const contract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, provider);
        try {
            const blobCount = await this.#countChunks(contract, hexName);
            for (let i = 0; i < blobCount; i++) {
                const result = await contract.readChunk(hexName, i);
                const chunk = ethers.getBytes(result[0]);
                cb.onProgress(i, blobCount, Buffer.from(chunk));
            }
        } catch (err) {
            cb.onFail(err)
        }
        cb.onFinish();
    }

    async estimateCost(request) {
        this.checkAddress();

        const {key, type} = request;
        if (!key) {
            throw new Error(`FlatDirectory: Invalid key!`);
        }

        if (type === UPLOAD_TYPE_BLOB) {
            return await this.#estimateCostByBlob(request);
        } else {
            return await this.#estimateCostByCallData(request);
        }
    }

    async upload(request) {
        const {key, callback, type} = request;
        if (!callback) {
            throw new Error(`FlatDirectory: Invalid callback object!`);
        }
        if (!key) {
            callback.onFail(new Error(`FlatDirectory: Invalid key!`));
            callback.onFinish(0, 0, 0);
            return;
        }
        if (!this.#contractAddr) {
            callback.onFail(new Error(`FlatDirectory: FlatDirectory not deployed!`));
            callback.onFinish(0, 0, 0);
            return;
        }

        if (type === UPLOAD_TYPE_BLOB) {
            return await this.#uploadByBlob(request);
        } else {
            return await this.#uploadByCallData(request);
        }
    }

    // private method
    async #estimateCostByBlob(request) {
        const {key, content, gasIncPct = 0} = request;

        if (!this.#isSupportBlob) {
            throw new Error(`FlatDirectory: The contract does not support blob upload!`);
        }

        const blobLength = this.#getBlobLength(content);
        if (blobLength === -1) {
            throw new Error(`FlatDirectory: Invalid upload content!`);
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const fileMod = await fileContract.getStorageMode(hexName);
        if (fileMod !== BigInt(UPLOAD_TYPE_BLOB) && fileMod !== 0n) {
            throw new Error(`FlatDirectory: This file does not support blob upload!`);
        }

        let totalGasCost = 0n;
        let totalStorageCost = 0n;
        let gasLimit = 0;
        const [cost, oldChunkLength, maxFeePerBlobGas, gasFeeData] = await Promise.all([
            fileContract.upfrontPayment(),
            this.#countChunks(fileContract, hexName),
            this.#blobUploader.getBlobGasPrice(),
            this.#blobUploader.getGasPrice(),
        ]);

        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const {
                blobArr,
                chunkIdArr,
                chunkSizeArr,
                blobHashRequestArr
            } = await this.#getBlobInfo(fileContract, content, hexName, blobLength, i);

            let blobHashArr;
            // check change
            if (chunkIdArr[0] < oldChunkLength) {
                blobHashArr = await this.#getBlobHashes(blobArr);
                const isChange = await this.#checkChange(blobHashArr, blobHashRequestArr);
                if (!isChange) {
                    continue;
                }
            }

            // upload
            // storage cost
            const value = cost * BigInt(blobArr.length);
            totalStorageCost += value;
            // gas cost
            if (gasLimit === 0) {
                blobHashArr = blobHashArr ? blobHashArr : await this.#getBlobHashes(blobArr);
                gasLimit = await fileContract.writeChunks.estimateGas(hexName, chunkIdArr, chunkSizeArr, {
                    value: value,
                    blobVersionedHashes: blobHashArr
                });
            }
            const gasCost = (gasFeeData.maxFeePerGas + gasFeeData.maxPriorityFeePerGas) * BigInt(100 + gasIncPct) / BigInt(100) * gasLimit;
            const blobGasCost = maxFeePerBlobGas * BigInt(100 + gasIncPct) / BigInt(100) * BigInt(BLOB_SIZE);
            totalGasCost += gasCost + blobGasCost;
        }

        return {
            storageCost: totalStorageCost,
            gasCost: totalGasCost
        }
    }

    async #estimateCostByCallData(request) {
        const {key, content, gasIncPct = 0} = request;

        const {chunkDataSize, chunkLength} = this.#getChunkLength(content);
        if (chunkDataSize === -1) {
            throw new Error(`FlatDirectory: Invalid upload content!`);
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const fileMod = await fileContract.getStorageMode(hexName);
        if (fileMod !== BigInt(UPLOAD_TYPE_CALLDATA) && fileMod !== 0n) {
            throw new Error(`FlatDirectory: This file does not support calldata upload!`);
        }

        const [oldChunkLength, gasFeeData] = await Promise.all([
            this.#countChunks(fileContract, hexName),
            this.#blobUploader.getGasPrice(),
        ]);

        let totalStorageCost = 0n;
        let totalGasCost = 0n;
        let gasLimit = 0;
        for (let i = 0; i < chunkLength; i++) {
            const chunk = isBuffer(content) ? Buffer.from(content).subarray(i * chunkDataSize, (i + 1) * chunkDataSize) :
                await getFileChunk(content, content.size, i * chunkDataSize, (i + 1) * chunkDataSize);

            // check is change
            if (i < oldChunkLength) {
                const localHash = ethers.keccak256(chunk);
                const hash = await fileContract.getChunkHash(hexName, i);
                if (localHash === hash) {
                    continue;
                }
            }

            // get cost, Galileo need stake
            let cost = 0n;
            if (chunk.length > (24 * 1024 - 326)) {
                cost = Math.floor((chunk.length + 326) / 1024 / 24);
                cost = ethers.parseEther(cost.toString());
            }
            if (i === chunkLength - 1 || gasLimit === 0) {
                const hexData = '0x' + chunk.toString('hex');
                gasLimit = await fileContract.writeChunk.estimateGas(hexName, 0, hexData, {
                    value: cost
                });
            }
            totalStorageCost += cost;
            totalGasCost += (gasFeeData.maxFeePerGas + gasFeeData.maxPriorityFeePerGas)
                * BigInt(100 + gasIncPct) / BigInt(100) * gasLimit;
        }

        return {
            storageCost: totalStorageCost,
            gasCost: totalGasCost
        }
    }

    async #uploadByBlob(request) {
        let totalUploadChunks = 0;
        let totalUploadSize = 0;
        let totalStorageCost = 0n;

        const {key, content, callback, gasIncPct} = request;
        if (!this.#isSupportBlob) {
            callback.onFail(new Error(`FlatDirectory: The contract does not support blob upload!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const blobLength = this.#getBlobLength(content);
        if (blobLength === -1) {
            callback.onFail(new Error(`FlatDirectory: Invalid upload content!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const fileMod = await fileContract.getStorageMode(hexName);
        if (fileMod !== BigInt(UPLOAD_TYPE_BLOB) && fileMod !== 0n) {
            callback.onFail(new Error(`FlatDirectory: This file does not support blob upload!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }


        // check old data
        const [cost, oldBlobLength] = await Promise.all([
            fileContract.upfrontPayment(),
            this.#countChunks(fileContract, hexName)
        ]);
        const clearState = await this.#clearOldFile(hexName, blobLength, oldBlobLength);
        if (clearState === REMOVE_FAIL) {
            callback.onFail(new Error(`FlatDirectory: Failed to delete old data!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const {
                blobArr,
                chunkIdArr,
                chunkSizeArr,
                blobHashRequestArr
            } = await this.#getBlobInfo(fileContract, content, hexName, blobLength, i);
            const blobCommitmentArr = await this.#getBlobCommitments(blobArr);

            // check change
            if (clearState === REMOVE_NORMAL) {
                try {
                    const blobHashArr = this.#getHashes(blobCommitmentArr);
                    const isChange = await this.#checkChange(blobHashArr, blobHashRequestArr);
                    if (!isChange) {
                        callback.onProgress(chunkIdArr[chunkIdArr.length - 1], blobLength, false);
                        continue;
                    }
                } catch (e) {
                    callback.onFail(e);
                    break;
                }
            }

            // upload
            try {
                const status = await this.#uploadBlob(fileContract, key, hexName, blobArr, blobCommitmentArr, chunkIdArr, chunkSizeArr, cost, gasIncPct);
                if (!status) {
                    callback.onFail(new Error("FlatDirectory: Sending transaction failed."));
                    break;
                }
            } catch (e) {
                callback.onFail(e);
                break;
            }

            // success
            callback.onProgress(chunkIdArr[chunkIdArr.length - 1], blobLength, true);
            totalStorageCost += cost * BigInt(blobArr.length);
            totalUploadChunks += blobArr.length;
            for (let i = 0; i < chunkSizeArr.length; i++) {
                totalUploadSize += chunkSizeArr[i];
            }
        }

        callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
    }

    async #uploadByCallData(request) {
        let totalUploadChunks = 0;
        let totalUploadSize = 0;
        let totalStorageCost = 0n;

        const {key, content, callback, gasIncPct} = request;
        const {chunkDataSize, chunkLength} = this.#getChunkLength(content);
        if (chunkDataSize === -1) {
            callback.onFail(new Error(`FlatDirectory: Invalid upload content!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const fileMod = await fileContract.getStorageMode(hexName);
        if (fileMod !== BigInt(UPLOAD_TYPE_CALLDATA) && fileMod !== 0n) {
            callback.onFail(new Error(`FlatDirectory: This file does not support calldata upload!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // check old data
        const oldChunkLength = await this.#countChunks(fileContract, hexName);
        const clearState = await this.#clearOldFile(hexName, chunkLength, oldChunkLength);
        if (clearState === REMOVE_FAIL) {
            callback.onFail(new Error(`FlatDirectory: Failed to delete old data!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        for (let i = 0; i < chunkLength; i++) {
            const chunk = isBuffer(content) ? Buffer.from(content).subarray(i * chunkDataSize, (i + 1) * chunkDataSize) :
                await getFileChunk(content, content.size, i * chunkDataSize, (i + 1) * chunkDataSize);

            // check is change
            if (clearState === REMOVE_NORMAL) {
                const localHash = ethers.keccak256(chunk);
                try {
                    const hash = await fileContract.getChunkHash(hexName, i);
                    if (localHash === hash) {
                        callback.onProgress(i, chunkLength, false);
                        continue;
                    }
                } catch (e) {
                    callback.onFail(e);
                    break;
                }
            }

            // upload
            try {
                const status = await this.#uploadCallData(fileContract, key, hexName, i, chunk, gasIncPct);
                if (!status) {
                    callback.onFail(new Error("FlatDirectory: Sending transaction failed."));
                    break;
                }
            } catch (e) {
                callback.onFail(e);
                break;
            }

            // success
            const cost = chunk.length > 24 * 1024 - 326 ? BigInt(Math.floor((chunk.length + 326) / 1024 / 24)) : 0n;
            callback.onProgress(i, chunkLength, true);
            totalStorageCost += cost;
            totalUploadChunks++;
            totalUploadSize += chunk.length;
        }

        callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
    }

    async #clearOldFile(key, chunkLength, oldChunkLength) {
        if (oldChunkLength > chunkLength) {
            // remove
            const v = await this.remove(key);
            if (v) {
                return REMOVE_SUCCESS;
            } else {
                return REMOVE_FAIL;
            }
        } else if (oldChunkLength === 0) {
            return REMOVE_SUCCESS;
        } else {
            return REMOVE_NORMAL;
        }
    }

    async #checkChange(blobHashArr, blobHashRequestArr) {
        const dataHashArr = await Promise.all(blobHashRequestArr);
        for (let i = 0; i < blobHashArr.length; i++) {
            if (blobHashArr[i] !== dataHashArr[i]) {
                return true;
            }
        }
        return false;
    }

    async #uploadBlob(fileContract, key, hexName, blobArr, blobCommitmentArr, chunkIdArr, chunkSizeArr, cost, gasIncPct) {
        // create tx
        const value = cost * BigInt(blobArr.length);
        const tx = await fileContract.writeChunks.populateTransaction(hexName, chunkIdArr, chunkSizeArr, {
            value: value,
        });
        // Increase % if user requests it
        if (gasIncPct > 0) {
            // Fetch the current gas price and increase it
            const feeData = await this.#blobUploader.getGasPrice();
            tx.maxFeePerGas = feeData.maxFeePerGas * BigInt(100 + gasIncPct) / BigInt(100);
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * BigInt(100 + gasIncPct) / BigInt(100);
            // blob gas
            const blobGas = await this.#blobUploader.getBlobGasPrice();
            tx.maxFeePerBlobGas = blobGas * BigInt(100 + gasIncPct) / BigInt(100);
        }
        // send
        const txResponse = await this.#blobUploader.sendTxLock(tx, blobArr, blobCommitmentArr);
        console.log(`FlatDirectory: The ${chunkIdArr} chunks hash is ${txResponse.hash}`, "", key);
        const txReceipt = await txResponse.wait();
        return txReceipt && txReceipt.status;
    }

    async #uploadCallData(fileContract, key, hexName, chunkId, chunk, gasIncPct) {
        const hexData = '0x' + chunk.toString('hex');
        const cost = chunk.length > 24 * 1024 - 326 ? BigInt(Math.floor((chunk.length + 326) / 1024 / 24)) : 0n;
        const tx = await fileContract.writeChunk.populateTransaction(hexName, chunkId, hexData, {
            value: ethers.parseEther(cost.toString())
        });
        // Increase % if user requests it
        if (gasIncPct > 0) {
            // Fetch the current gas price and increase it
            const feeData = await this.#blobUploader.getGasPrice();
            tx.maxFeePerGas = feeData.maxFeePerGas * BigInt(100 + gasIncPct) / BigInt(100);
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * BigInt(100 + gasIncPct) / BigInt(100);
        }

        // send
        const txResponse = await this.#blobUploader.sendTxLock(tx);
        console.log(`FlatDirectory: The ${chunkId} chunk hash is ${txResponse.hash}`, "", key);
        const txReceipt = await txResponse.wait();
        return txReceipt && txReceipt.status;
    }

    async #countChunks(fileContract, hexName) {
        const count = await fileContract.countChunks(hexName);
        // Bigint to number
        return Number(count);
    }

    async #getBlobCommitments(blobArr) {
        const isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
        const promises = isNode
            ? blobArr.map(blob => pool.exec('getCommitment', [blob]))
            : blobArr.map(blob => this.#blobUploader.getCommitment(blob));
        return await Promise.all(promises);
    }

    #getHashes(blobCommitmentArr) {
        return blobCommitmentArr.map(comment => getHash(comment));
    }

    async #getBlobHashes(blobArr) {
        const commitments = await this.#getBlobCommitments(blobArr);
        return this.#getHashes(commitments);
    }


    #getBlobLength(content) {
        let blobLength = -1;
        if (isFile(content)) {
            blobLength = Math.ceil(content.size / DEFAULT_BLOB_DATA_SIZE);
        } else if (isBuffer(content)) {
            blobLength = Math.ceil(content.length / DEFAULT_BLOB_DATA_SIZE);
        }
        return blobLength;
    }

    async #getBlobInfo(fileContract, content, hexName, blobLength, index) {
        const data = isBuffer(content)
            ? Buffer.from(content).subarray(index * DEFAULT_BLOB_DATA_SIZE, (index + MAX_BLOB_COUNT) * DEFAULT_BLOB_DATA_SIZE) :
            await getFileChunk(content, content.size, index * DEFAULT_BLOB_DATA_SIZE, (index + MAX_BLOB_COUNT) * DEFAULT_BLOB_DATA_SIZE);
        const blobArr = encodeBlobs(data);
        const chunkIdArr = [];
        const chunkSizeArr = [];
        const blobHashRequestArr = [];
        for (let j = 0; j < blobArr.length; j++) {
            chunkIdArr.push(index + j);
            if (index + j === blobLength - 1) {
                const size = isBuffer(content) ? content.length : content.size;
                chunkSizeArr.push(size - DEFAULT_BLOB_DATA_SIZE * (blobLength - 1));
            } else {
                chunkSizeArr.push(DEFAULT_BLOB_DATA_SIZE);
            }
            blobHashRequestArr.push(fileContract.getChunkHash(hexName, index + j));
        }
        return {
            blobArr,
            chunkIdArr,
            chunkSizeArr,
            blobHashRequestArr
        }
    }

    #getChunkLength(content) {
        let chunkDataSize = -1;
        let chunkLength = 1;
        if (isFile(content)) {
            chunkDataSize = content.size;
            if (GALILEO_CHAIN_ID === this.#chainId) {
                if (content.size > 475 * 1024) {
                    // Data need to be sliced if file > 475K
                    chunkDataSize = 475 * 1024;
                    chunkLength = Math.ceil(content.size / (475 * 1024));
                }
            } else {
                if (content.size > 24 * 1024 - 326) {
                    // Data need to be sliced if file > 24K
                    chunkDataSize = 24 * 1024 - 326;
                    chunkLength = Math.ceil(content.size / (24 * 1024 - 326));
                }
            }
        } else if (isBuffer(content)) {
            chunkDataSize = content.length;
            if (GALILEO_CHAIN_ID === this.#chainId) {
                if (content.length > 475 * 1024) {
                    // Data need to be sliced if file > 475K
                    chunkDataSize = 475 * 1024;
                    chunkLength = Math.ceil(content.length / (475 * 1024));
                }
            } else {
                if (content.length > 24 * 1024 - 326) {
                    // Data need to be sliced if file > 24K
                    chunkDataSize = 24 * 1024 - 326;
                    chunkLength = Math.ceil(content.length / (24 * 1024 - 326));
                }
            }
        }
        return {
            chunkDataSize,
            chunkLength
        }
    }
}
