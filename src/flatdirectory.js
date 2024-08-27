import {ethers} from "ethers";
import {
    BLOB_SIZE,
    BLOB_DATA_SIZE,
    OP_BLOB_DATA_SIZE,
    ETHSTORAGE_MAPPING,
    FlatDirectoryAbi,
    FlatDirectoryBytecode,
    MAX_BLOB_COUNT,
    UPLOAD_TYPE_BLOB,
    UPLOAD_TYPE_CALLDATA,
    MAX_RETRIES,
    VERSION_3,
    VERSION_2,
    VERSION_1,
    SOLC_VERSION_1_0_0,
    MAX_HASH_LIMIT
} from './param';
import {
    BlobUploader,
    encodeBlobs, encodeOpBlobs,
    getChainId, getFileChunk, getHash,
    isBuffer, isFile,
    stringToHex, isNodejs,
    retry
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
    #version;
    #blobSize;

    #wallet;
    #blobUploader;
    #retries;

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
        this.#retries = MAX_RETRIES;
    }

    async init(rpc, address) {
        await this.#blobUploader.init();
        this.#chainId = await getChainId(rpc);
        if (!address) return;

        const provider = new ethers.JsonRpcProvider(rpc);
        const fileContract = new ethers.Contract(address, FlatDirectoryAbi, provider);
        const [supportBlob, solcVersion] = await Promise.all([
            retry(() => fileContract.isSupportBlob(), this.#retries).catch(() => false),
            retry(() => fileContract.version(), this.#retries).catch(() => 0)
        ]);
        if (supportBlob) {
            this.#version = solcVersion === SOLC_VERSION_1_0_0 ? VERSION_3 : VERSION_2;
            this.#blobSize = solcVersion === SOLC_VERSION_1_0_0 ? OP_BLOB_DATA_SIZE : BLOB_DATA_SIZE;
        } else {
            this.#version = VERSION_1;
        }
    }

    #checkAddress() {
        if (!this.#contractAddr) {
            throw new Error(`FlatDirectory: FlatDirectory not deployed!`);
        }
    }

    async deploy() {
        this.#version = ETHSTORAGE_MAPPING[this.#chainId] != null ? VERSION_3 : VERSION_1;
        this.#blobSize = OP_BLOB_DATA_SIZE;

        const ethStorage = ETHSTORAGE_MAPPING[this.#chainId] || '0x0000000000000000000000000000000000000000';
        const factory = new ethers.ContractFactory(FlatDirectoryAbi, FlatDirectoryBytecode, this.#wallet);
        try {
            const contract = await factory.deploy(0, OP_BLOB_DATA_SIZE, ethStorage, {gasLimit: 3800000});
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
        this.#checkAddress();

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
        this.#checkAddress();

        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        try {
            const tx = await fileContract.remove(stringToHex(key));
            console.log(`FlatDirectory: Tx hash is ${tx.hash}`);
            const receipt = await tx.wait();
            return receipt.status;
        } catch (e) {
            console.error(`FlatDirectory: Failed to remove file: ${key}`, e.message);
        }
        return false;
    }

    async download(key, cb = defaultCallback) {
        this.#checkAddress();
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
            cb.onFail(err);
        }
        cb.onFinish();
    }

    async estimateCost(request) {
        this.#checkAddress();

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
            callback.onFinish(0, 0, 0n);
            return;
        }
        if (!this.#contractAddr) {
            callback.onFail(new Error(`FlatDirectory: FlatDirectory not deployed!`));
            callback.onFinish(0, 0, 0n);
            return;
        }

        if (type === UPLOAD_TYPE_BLOB) {
            return await this.#uploadByBlob(request);
        } else {
            return await this.#uploadByCallData(request);
        }
    }

    async #estimateCostByBlob(request) {
        const {key, content, gasIncPct = 0} = request;

        if (this.#version === VERSION_1) {
            throw new Error(`FlatDirectory: The contract does not support blob upload!`);
        }

        const blobLength = this.#getBlobLength(content);
        if (blobLength === -1) {
            throw new Error(`FlatDirectory: Invalid upload content!`);
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const [cost, oldBlobLength, maxFeePerBlobGas, gasFeeData, fileMod] = await Promise.all([
            retry(() => fileContract.upfrontPayment(), this.#retries),
            retry(() => this.#countChunks(fileContract, hexName), this.#retries),
            retry(() => this.#blobUploader.getBlobGasPrice(), this.#retries),
            retry(() => this.#blobUploader.getGasPrice(), this.#retries),
            retry(() => fileContract.getStorageMode(hexName), this.#retries)
        ]);

        if (fileMod !== BigInt(UPLOAD_TYPE_BLOB) && fileMod !== 0n) {
            throw new Error("FlatDirectory: This file does not support blob upload!");
        }

        // batch get old data hash
        let oldHashArr = [];
        if (oldBlobLength > 0 && blobLength >= oldBlobLength) {
            oldHashArr = await this.#getHashesFromContract(fileContract, hexName, oldBlobLength);
        }

        let totalGasCost = 0n;
        let totalStorageCost = 0n;
        let gasLimit = 0;
        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const {
                blobArr,
                chunkIdArr,
                chunkSizeArr
            } = await this.#getBlobInfo(fileContract, content, hexName, blobLength, i);

            let blobHashArr;
            // check change
            if (i + blobArr.length <= oldHashArr.length) {
                blobHashArr = await this.#getBlobHashes(blobArr);
                const cloudHashArr = oldHashArr.slice(i, i + blobHashArr.length);
                if (JSON.stringify(blobHashArr) === JSON.stringify(cloudHashArr)) {
                    continue;
                }
            }

            // storage cost
            const value = cost * BigInt(blobArr.length);
            totalStorageCost += value;
            // gas cost
            if (gasLimit === 0) {
                blobHashArr = blobHashArr ? blobHashArr : await this.#getBlobHashes(blobArr);
                gasLimit = await retry(() => fileContract.writeChunks.estimateGas(hexName, chunkIdArr, chunkSizeArr, {
                    value: value,
                    blobVersionedHashes: blobHashArr
                }), this.#retries);
            }
            const gasCost = (gasFeeData.maxFeePerGas + gasFeeData.maxPriorityFeePerGas) * BigInt(gasLimit)
                + maxFeePerBlobGas * BigInt(BLOB_SIZE);
            totalGasCost += gasCost;
        }

        totalGasCost += (totalGasCost * BigInt(gasIncPct)) / 100n;
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
        const [oldChunkLength, gasFeeData, fileMod] = await Promise.all([
            retry(() => this.#countChunks(fileContract, hexName), this.#retries),
            retry(() => this.#blobUploader.getGasPrice(), this.#retries),
            retry(() => fileContract.getStorageMode(hexName), this.#retries)
        ]);

        if (fileMod !== BigInt(UPLOAD_TYPE_CALLDATA) && fileMod !== 0n) {
            throw new Error(`FlatDirectory: This file does not support calldata upload!`);
        }

        // batch get old data hash
        let oldHashArr = [];
        if (oldChunkLength > 0 && chunkLength >= oldChunkLength) {
            oldHashArr = await this.#getHashesFromContract(fileContract, hexName, oldChunkLength);
        }

        let totalStorageCost = 0n;
        let totalGasCost = 0n;
        let gasLimit = 0;
        for (let i = 0; i < chunkLength; i++) {
            const chunk = isBuffer(content) ? Buffer.from(content).subarray(i * chunkDataSize, (i + 1) * chunkDataSize) :
                await getFileChunk(content, content.size, i * chunkDataSize, (i + 1) * chunkDataSize);

            // check is change
            if (i < oldHashArr.length) {
                if (ethers.keccak256(chunk) === oldHashArr[i]) {
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
                gasLimit = await retry(() => fileContract.writeChunk.estimateGas(hexName, 0, hexData, {value: cost}), this.#retries);
            }
            totalStorageCost += cost;
            totalGasCost += (gasFeeData.maxFeePerGas + gasFeeData.maxPriorityFeePerGas) * gasLimit;
        }
        totalGasCost += (totalGasCost * BigInt(gasIncPct)) / 100n;

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
        if (this.#version === VERSION_1) {
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
        const [cost, oldBlobLength, fileMod] = await Promise.all([
            retry(() => fileContract.upfrontPayment(), this.#retries),
            retry(() => this.#countChunks(fileContract, hexName), this.#retries),
            retry(() => fileContract.getStorageMode(hexName), this.#retries)
        ]);

        if (fileMod !== BigInt(UPLOAD_TYPE_BLOB) && fileMod !== 0n) {
            callback.onFail(new Error(`FlatDirectory: This file does not support blob upload!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const clearState = await retry(() => this.#clearOldFile(hexName, blobLength, oldBlobLength), this.#retries);
        if (clearState === REMOVE_FAIL) {
            callback.onFail(new Error(`FlatDirectory: Failed to delete old data!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // batch get old data hash
        let oldHashArr = [];
        if (clearState === REMOVE_NORMAL) {
            oldHashArr = await this.#getHashesFromContract(fileContract, hexName, oldBlobLength);
        }

        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const {
                blobArr,
                chunkIdArr,
                chunkSizeArr
            } = await this.#getBlobInfo(fileContract, content, hexName, blobLength, i);
            const blobCommitmentArr = await this.#getBlobCommitments(blobArr);

            // check change
            if (i + blobArr.length <= oldHashArr.length) {
                const localHashArr = this.#getHashes(blobCommitmentArr);
                const cloudHashArr = oldHashArr.slice(i, i + localHashArr.length);
                if (JSON.stringify(localHashArr) === JSON.stringify(cloudHashArr)) {
                    callback.onProgress(chunkIdArr[chunkIdArr.length - 1], blobLength, false);
                    continue;
                }
            }

            // upload
            const status = await retry(() => this.#uploadBlob(fileContract, key, hexName, blobArr, blobCommitmentArr, chunkIdArr, chunkSizeArr, cost, gasIncPct), this.#retries);
            if (!status) {
                callback.onFail(new Error("FlatDirectory: Sending transaction failed."));
                break;
            }

            // success
            callback.onProgress(chunkIdArr[chunkIdArr.length - 1], blobLength, true);
            totalStorageCost += cost * BigInt(blobArr.length);
            totalUploadChunks += blobArr.length;
            totalUploadSize += chunkSizeArr.reduce((acc, size) => acc + size, 0);
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
        const [oldChunkLength, fileMod] = await Promise.all([
            retry(() => this.#countChunks(fileContract, hexName), this.#retries),
            retry(() => fileContract.getStorageMode(hexName), this.#retries)
        ]);
        if (fileMod !== BigInt(UPLOAD_TYPE_CALLDATA) && fileMod !== 0n) {
            callback.onFail(new Error(`FlatDirectory: This file does not support calldata upload!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // check old data
        const clearState = await retry(() => this.#clearOldFile(hexName, chunkLength, oldChunkLength), this.#retries);
        if (clearState === REMOVE_FAIL) {
            callback.onFail(new Error(`FlatDirectory: Failed to delete old data!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // batch get old data hash
        let oldHashArr = [];
        if (clearState === REMOVE_NORMAL) {
            oldHashArr = await this.#getHashesFromContract(fileContract, hexName, oldChunkLength);
        }

        for (let i = 0; i < chunkLength; i++) {
            const chunk = isBuffer(content) ? Buffer.from(content).subarray(i * chunkDataSize, (i + 1) * chunkDataSize) :
                await getFileChunk(content, content.size, i * chunkDataSize, (i + 1) * chunkDataSize);

            // check is change
            if (i < oldHashArr.length) {
                if (ethers.keccak256(chunk) === oldHashArr[i]) {
                    callback.onProgress(i, chunkLength, false);
                    continue;
                }
            }

            // upload
            const status = await retry(() => this.#uploadCallData(fileContract, key, hexName, i, chunk, gasIncPct), this.#retries);
            if (!status) {
                callback.onFail(new Error("FlatDirectory: Sending transaction failed."));
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
        this.#printHashLog(key, chunkIdArr, txResponse.hash);
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
        this.#printHashLog(key, chunkId, txResponse.hash);
        const txReceipt = await txResponse.wait();
        return txReceipt && txReceipt.status;
    }

    async #countChunks(fileContract, hexName) {
        const count = await fileContract.countChunks(hexName);
        // Bigint to number
        return Number(count);
    }

    async #getBlobCommitments(blobArr) {
        const promises = isNodejs()
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
            blobLength = Math.ceil(content.size / this.#blobSize);
        } else if (isBuffer(content)) {
            blobLength = Math.ceil(content.length / this.#blobSize);
        }
        return blobLength;
    }

    async #getBlobInfo(fileContract, content, hexName, blobLength, index) {
        const data = isBuffer(content)
            ? Buffer.from(content).subarray(index * this.#blobSize, (index + MAX_BLOB_COUNT) * this.#blobSize) :
            await getFileChunk(content, content.size, index * this.#blobSize, (index + MAX_BLOB_COUNT) * this.#blobSize);
        const blobArr = this.#version === VERSION_3 ? encodeOpBlobs(data) : encodeBlobs(data);
        const chunkIdArr = [];
        const chunkSizeArr = [];
        for (let j = 0; j < blobArr.length; j++) {
            chunkIdArr.push(index + j);
            if (index + j === blobLength - 1) {
                const size = isBuffer(content) ? content.length : content.size;
                chunkSizeArr.push(size - this.#blobSize * (blobLength - 1));
            } else {
                chunkSizeArr.push(this.#blobSize);
            }
        }
        return {
            blobArr,
            chunkIdArr,
            chunkSizeArr
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

    #printHashLog(key, chunkIds, hash) {
        if (Array.isArray(chunkIds) && chunkIds.length > 1) {
            console.log(`FlatDirectory: The transaction hash for chunks ${chunkIds} is ${hash}`, "", key);
        } else {
            console.log(`FlatDirectory: The transaction hash for chunk ${chunkIds} is ${hash}`, "", key);
        }
    }

    async #getHashesFromContract(fileContract, hexName, oldBlobLength) {
        const hashPromises = [];
        for (let i = 0; i < oldBlobLength; i += MAX_HASH_LIMIT) {
            const max = Math.min(i + MAX_HASH_LIMIT, oldBlobLength);
            const chunkIdArr = [];
            for (let j = i; j < max; j++) {
                chunkIdArr.push(j);
            }
            hashPromises.push(this.#chunkHashes(fileContract, hexName, chunkIdArr));
        }
        const allHashes = await Promise.all(hashPromises);
        return allHashes.flat();
    }

    async #chunkHashes(fileContract, hexName, chunkIdArr) {
        if (this.#version === VERSION_3) {
            return await retry(() => fileContract.getChunkHashes(hexName, chunkIdArr), this.#retries);
        }

        // old
        const blobHashRequestArr = chunkIdArr.map(id => fileContract.getChunkHash(hexName, id))
        return await retry(() => Promise.all(blobHashRequestArr), this.#retries);;
    }
}
