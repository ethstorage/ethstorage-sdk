import {ethers} from "ethers";
import {
    BLOB_SIZE, BLOB_DATA_SIZE, OP_BLOB_DATA_SIZE,
    ETHSTORAGE_MAPPING,
    FlatDirectoryAbi,
    FlatDirectoryBytecode,
    MAX_BLOB_COUNT,
    UPLOAD_TYPE_BLOB, UPLOAD_TYPE_CALLDATA,
    MAX_RETRIES, MAX_CHUNKS,
    VERSION_3, VERSION_2, VERSION_1,
    SOLC_VERSION_1_0_0
} from './param';
import {
    BlobUploader,
    encodeBlobs, encodeOpBlobs,
    getChainId, getFileChunk, getHash,
    isBuffer, isFile,
    stringToHex, isNodejs,
    retry,
    createFlatDirectoryContract, countChunks,
    getChunkHashes, getChunkHash, limit,
    getUploadInfo, getStorageMode, upfrontPayment
} from "./utils";

import workerpool from 'workerpool';
import {hexlify} from "ethers/src.ts/utils/data";
const pool = workerpool.pool(__dirname + '/worker.cjs.js');

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

        const fileContract = createFlatDirectoryContract(address, this.#wallet);
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

    version() {
        return this.#version;
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
        const fileContract = createFlatDirectoryContract(this.#contractAddr, this.#wallet);
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

        const fileContract = createFlatDirectoryContract(this.#contractAddr, this.#wallet);
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
            const blobCount = await countChunks(contract, hexName, this.#retries);
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

    async fetchHashes(keys, concurrencyLimit = 5) {
        if (!keys) {
            throw new Error(`Invalid keys.`);
        }

        const contract = createFlatDirectoryContract(this.#contractAddr, this.#wallet);
        // get file chunks
        const chunkCountPromises = keys.map(key => async () => {
            const chunkCount = await countChunks(contract, stringToHex(key), this.#retries);
            return {key, chunkCount};
        });
        const fileInfos = await limit(concurrencyLimit, chunkCountPromises);
        return this.#fetchHashes(fileInfos, concurrencyLimit);
    }

    async #fetchHashes(fileInfos, concurrencyLimit = 5) {
        const allHashes = {};
        const contract = createFlatDirectoryContract(this.#contractAddr, this.#wallet);
        if (this.#version === VERSION_3) {
            // new contract, use getBatchChunkHashes((bytes,uint256[])[] memory fileChunks)
            const batchArray = [];
            let currentBatch = {};
            let currentChunkCount = 0;
            for (const { key, chunkCount } of fileInfos) {
                if (chunkCount === 0) {
                    allHashes[key] = [];
                    continue;
                }

                allHashes[key] = new Array(chunkCount);
                for (let i = 0; i < chunkCount; i++) {
                    if (!currentBatch[key]) {
                        currentBatch[key] = [];
                    }
                    currentBatch[key].push(i);
                    currentChunkCount++;
                    // If the batch reaches the chunk limit, create a task
                    if (currentChunkCount === MAX_CHUNKS) {
                        batchArray.push(currentBatch);
                        currentBatch = {};
                        currentChunkCount = 0;
                    }
                }
            }
            if (Object.keys(currentBatch).length > 0) {
                batchArray.push(currentBatch);
            }

            // request
            const hashPromises = batchArray.map(batch => async () => {
                const fileChunksArray = Object.keys(batch).map(name => ({
                    name,
                    chunkIds: batch[name]
                }));
                return await getChunkHashes(contract, fileChunksArray, this.#retries);
            });
            const hashResults = await limit(concurrencyLimit, hashPromises);
            // Combine results
            hashResults.flat().forEach(({name, chunkId, hash}) => {
                allHashes[name][chunkId] = hash;
            });
        } else {
            // old contract, use getChunkHash(bytes memory name, uint256 chunkId);
            const hashPromises = fileInfos.flatMap(({ key, chunkCount }) => {
                if (chunkCount === 0) {
                    allHashes[key] = [];
                    return [];
                }

                allHashes[key] = new Array(chunkCount);
                return Array.from({ length: chunkCount }, (_, i) => async () => {
                    return await getChunkHash(contract, key, i, this.#retries);
                });
            });

            const hashResults = await limit(concurrencyLimit, hashPromises);
            hashResults.forEach(({name, chunkId, hash}) => {
                allHashes[name][chunkId] = hash;
            });
        }
        return allHashes;
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



    // private method
    #checkAddress() {
        if (!this.#contractAddr) {
            throw new Error(`FlatDirectory: FlatDirectory not deployed!`);
        }
    }

    async #estimateCostByBlob(request) {
        let {key, content, chunkHashes, gasIncPct = 0} = request;
        if (this.#version === VERSION_1) {
            throw new Error(`FlatDirectory: The contract does not support blob upload!`);
        }

        // check data
        const blobLength = this.#getBlobLength(content);
        if (blobLength === -1) {
            throw new Error(`FlatDirectory: Invalid upload content!`);
        }

        // get file info
        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const {
            fileMod, oldChunkLength, cost,
            maxFeePerBlobGas, gasFeeData
        } = await this.#getEstimateBlobInfo(fileContract, hexName);
        if (fileMod !== UPLOAD_TYPE_BLOB && fileMod !== 0) {
            throw new Error("FlatDirectory: This file does not support blob upload!");
        }

        // Get old chunk hashes, If the chunk hashes is not passed, it is obtained here
        if (!chunkHashes) {
            const hashes = this.#fetchHashes([{ key, oldChunkLength }]);
            chunkHashes =  hashes[key];
        }

        let totalGasCost = 0n;
        let totalStorageCost = 0n;
        let gasLimit = 0;
        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const { blobArr, chunkIdArr, chunkSizeArr } = await this.#getBlobInfo(fileContract, content, hexName, blobLength, i);

            let blobHashArr;
            // check change
            if (i + blobArr.length <= chunkHashes.length) {
                blobHashArr = await this.#getBlobHashes(blobArr);
                const cloudHashArr = chunkHashes.slice(i, i + blobHashArr.length);
                if (JSON.stringify(blobHashArr) === JSON.stringify(cloudHashArr)) {
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
        let {key, content, chunkHashes, gasIncPct = 0} = request;

        const {chunkDataSize, chunkLength} = this.#getChunkLength(content);
        if (chunkDataSize === -1) {
            throw new Error(`FlatDirectory: Invalid upload content!`);
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const { fileMod, oldChunkLength, gasFeeData } = await this.#getEstimateCallDataInfo(fileContract, hexName);
        if (fileMod !== UPLOAD_TYPE_CALLDATA && fileMod !== 0) {
            throw new Error(`FlatDirectory: This file does not support calldata upload!`);
        }

        // Get old chunk hashes, If the chunk hashes is not passed, it is obtained here
        if (!chunkHashes) {
            const hashes = this.#fetchHashes([{ key, oldChunkLength }]);
            chunkHashes =  hashes[key];
        }

        let totalStorageCost = 0n;
        let totalGasCost = 0n;
        let gasLimit = 0;
        for (let i = 0; i < chunkLength; i++) {
            const chunk = isBuffer(content) ? Buffer.from(content).subarray(i * chunkDataSize, (i + 1) * chunkDataSize) :
                await getFileChunk(content, content.size, i * chunkDataSize, (i + 1) * chunkDataSize);

            // check is change
            if (i < chunkHashes.length) {
                if (ethers.keccak256(chunk) === chunkHashes[i]) {
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

        let {key, content, callback, chunkHashes, gasIncPct} = request;
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
        const { fileMod, oldChunkLength, cost} = await this.#getUploadBlobInfo(fileContract, hexName);
        if (fileMod !== UPLOAD_TYPE_BLOB && fileMod !== 0) {
            callback.onFail(new Error(`FlatDirectory: This file does not support blob upload!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const clearState = await retry(() => this.#clearOldFile(fileContract, hexName, blobLength, oldChunkLength), this.#retries);
        if (!clearState) {
            callback.onFail(new Error(`FlatDirectory: Failed to delete old data!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // Get old chunk hashes, If the chunk hashes is not passed, it is obtained here
        if (!chunkHashes) {
            const hashes = this.#fetchHashes([{ key, oldChunkLength }]);
            chunkHashes =  hashes[key];
        }

        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const {
                blobArr, chunkIdArr, chunkSizeArr
            } = await this.#getBlobInfo(fileContract, content, hexName, blobLength, i);
            const blobCommitmentArr = await this.#getBlobCommitments(blobArr);

            // check change
            if (i + blobArr.length <= chunkHashes.length) {
                const localHashArr = this.#getHashes(blobCommitmentArr);
                const cloudHashArr = chunkHashes.slice(i, i + localHashArr.length);
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

        let {key, content, callback, chunkHashes, gasIncPct} = request;
        const {chunkDataSize, chunkLength} = this.#getChunkLength(content);
        if (chunkDataSize === -1) {
            callback.onFail(new Error(`FlatDirectory: Invalid upload content!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const {fileMod, oldChunkLength} = await this.#getUploadCallDataInfo(fileContract, hexName);
        if (fileMod !== UPLOAD_TYPE_CALLDATA && fileMod !== 0) {
            callback.onFail(new Error(`FlatDirectory: This file does not support calldata upload!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // check old data
        const clearState = await retry(() => this.#clearOldFile(fileContract, hexName, chunkLength, oldChunkLength), this.#retries);
        if (!clearState) {
            callback.onFail(new Error(`FlatDirectory: Failed to delete old data!`));
            callback.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // Get old chunk hashes, If the chunk hashes is not passed, it is obtained here
        if (!chunkHashes) {
            const hashes = this.#fetchHashes([{ key, oldChunkLength }]);
            chunkHashes =  hashes[key];
        }

        for (let i = 0; i < chunkLength; i++) {
            const chunk = isBuffer(content) ? Buffer.from(content).subarray(i * chunkDataSize, (i + 1) * chunkDataSize) :
                await getFileChunk(content, content.size, i * chunkDataSize, (i + 1) * chunkDataSize);

            // check is change
            if (i < chunkHashes.length) {
                if (ethers.keccak256(chunk) === chunkHashes[i]) {
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

    async #getEstimateBlobInfo(contract, hexName) {
        if (this.#version === VERSION_3) {
            const [result, maxFeePerBlobGas, gasFeeData] = await Promise.all([
                getUploadInfo(contract, hexName, this.#retries),
                retry(() => this.#blobUploader.getBlobGasPrice(), this.#retries),
                retry(() => this.#blobUploader.getGasPrice(), this.#retries),
            ]);
            return {
                fileMod: result.mode,
                oldChunkLength: result.chunkSize,
                cost: result.cost,
                maxFeePerBlobGas,
                gasFeeData
            }
        } else {
            const [fileMod, oldChunkLength, cost, maxFeePerBlobGas, gasFeeData] = await Promise.all([
                getStorageMode(contract, hexName, this.#retries),
                countChunks(contract, hexName, this.#retries),
                upfrontPayment(contract, this.#retries),
                retry(() => this.#blobUploader.getBlobGasPrice(), this.#retries),
                retry(() => this.#blobUploader.getGasPrice(), this.#retries),
            ]);
            return {
                fileMod: fileMod,
                oldChunkLength: oldChunkLength,
                cost: cost,
                maxFeePerBlobGas,
                gasFeeData
            }
        }
    }

    async #getEstimateCallDataInfo(contract, hexName) {
        if (this.#version === VERSION_3) {
            const [result, gasFeeData] = await Promise.all([
                getUploadInfo(contract, hexName, this.#retries),
                retry(() => this.#blobUploader.getGasPrice(), this.#retries),
            ]);
            return {
                fileMod: result.mode,
                oldChunkLength: result.chunkSize,
                gasFeeData
            }
        } else {
            const [fileMod, oldChunkLength, gasFeeData] = await Promise.all([
                getStorageMode(contract, hexName, this.#retries),
                countChunks(contract, hexName, this.#retries),
                retry(() => this.#blobUploader.getGasPrice(), this.#retries),
            ]);
            return {
                fileMod: fileMod,
                oldChunkLength: oldChunkLength,
                gasFeeData
            }
        }
    }

    async #getUploadBlobInfo(contract, hexName) {
        if (this.#version === VERSION_3) {
            const result = await getUploadInfo(contract, hexName, this.#retries);
            return {
                fileMod: result.mode,
                oldChunkLength: result.chunkSize,
                cost: result.cost
            }
        } else {
            const [fileMod, oldChunkLength, cost] = await Promise.all([
                getStorageMode(contract, hexName, this.#retries),
                countChunks(contract, hexName, this.#retries),
                upfrontPayment(contract, this.#retries),
            ]);
            return {
                fileMod: fileMod,
                oldChunkLength: oldChunkLength,
                cost: cost
            }
        }
    }

    async #getUploadCallDataInfo(contract, hexName) {
        if (this.#version === VERSION_3) {
            const result = await getUploadInfo(contract, hexName, this.#retries);
            return {
                fileMod: result.mode,
                oldChunkLength: result.chunkSize,
            }
        } else {
            const [fileMod, oldChunkLength] = await Promise.all([
                getStorageMode(contract, hexName, this.#retries),
                countChunks(contract, hexName, this.#retries)
            ]);
            return {
                fileMod: fileMod,
                oldChunkLength: oldChunkLength,
            }
        }
    }

    async #clearOldFile(contract, key, chunkLength, oldChunkLength) {
        if (oldChunkLength > chunkLength) {
            // remove
            try {
                const tx = await contract.truncate(stringToHex(key), chunkLength);
                console.log(`FlatDirectory: Tx hash is ${tx.hash}`);
                const receipt = await tx.wait();
                return receipt?.status === 1;
            } catch (e) {
                console.error(`FlatDirectory: Failed to remove file: ${key}`, e.message);
                return false;
            }
        }
        return true;
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
        const hexData = ethers.hexlify(new Uint8Array(chunk));
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
        return { blobArr, chunkIdArr, chunkSizeArr }
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
}
