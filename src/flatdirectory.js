import {ethers} from "ethers";
import {
    BLOB_DATA_SIZE,
    BLOB_SIZE,
    ETHSTORAGE_MAPPING,
    FlatDirectoryAbi,
    FlatDirectoryBytecode,
    MAX_BLOB_COUNT,
} from './param';
import {BlobUploader, encodeBlobs, getChainId, getFileChunk, stringToHex} from "./utils";

const REMOVE_FAIL = -1;
const REMOVE_NORMAL = 0;
const REMOVE_SUCCESS = 1;

const VERSION_BLOB = '2';


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
            const contract = await factory.deploy(0, BLOB_DATA_SIZE, ethStorage, {gasLimit: 3800000});
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

    async fetchData(key) {
        this.checkAddress();
        if (!this.#ethStorageRpc) {
            throw new Error(`FlatDirectory: Reading content requires providing 'ethStorageRpc'.`);
        }

        let buff = [];
        const hexName = stringToHex(key);
        const provider = new ethers.JsonRpcProvider(this.#ethStorageRpc);
        const contract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, provider);
        try {
            const blobCount = await contract.countChunks(hexName);
            for (let i = 0; i < blobCount; i++) {
                const result = await contract.readChunk(hexName, i);
                const chunk = ethers.getBytes(result[0]);
                buff = [...buff, ...chunk];
            }
        } catch (e) {
            console.error(`FlatDirectory: Download failed!`, e.message);
        }
        return Buffer.from(buff);
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
            const blobCount = await contract.countChunks(hexName);
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

    async estimateCost(key, data) {
        await this.#checkUploadStatus(key);

        const content = Buffer.from(data);
        const blobs = encodeBlobs(content);
        const blobLength = blobs.length;
        const blobDataSize = BLOB_DATA_SIZE;
        const hexName = stringToHex(key);

        let totalGasCost = 0n;
        let totalStorageCost = 0n;
        let gasLimit = 0;
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const [cost, oldChunkLength, maxFeePerBlobGas, gasFeeData] = await Promise.all([
            fileContract.upfrontPayment(),
            fileContract.countChunks(hexName),
            this.#blobUploader.getBlobGasPrice(),
            this.#blobUploader.getGasPrice(),
        ]);
        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const blobArr = [];
            const chunkIdArr = [];
            const chunkSizeArr = [];
            const blobHashArr = [];
            const blobHashRequestArr = [];
            let max = i + MAX_BLOB_COUNT > blobLength ? blobLength : i + MAX_BLOB_COUNT;
            for (let j = i; j < max; j++) {
                blobArr.push(blobs[j]);
                chunkIdArr.push(j);
                chunkSizeArr.push(blobDataSize);

                blobHashArr.push(this.#blobUploader.getBlobHash(blobs[j]));
                blobHashRequestArr.push(fileContract.getChunkHash(hexName, j));
            }

            // check change
            if (oldChunkLength !== 0 && chunkIdArr[0] < oldChunkLength) {
                const isChange = await this.#checkChange(fileContract, blobHashArr, blobHashRequestArr);
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
                gasLimit = await fileContract.writeChunks.estimateGas(hexName, chunkIdArr, chunkSizeArr, {
                    value: value,
                    blobVersionedHashes: blobHashArr
                });
            }
            const gasCost = (gasFeeData.maxFeePerGas + gasFeeData.maxPriorityFeePerGas) * gasLimit;
            const blobGasCost = maxFeePerBlobGas * BigInt(BLOB_SIZE);
            totalGasCost += gasCost + blobGasCost;
        }

        return {
            storageCost: totalStorageCost,
            gasCost: totalGasCost
        }
    }

    async estimateFileCost(key, file) {
        await this.#checkUploadStatus(key);

        const fileSize = file.size;
        const blobDataSize = BLOB_DATA_SIZE;
        const blobLength = Math.ceil(fileSize / blobDataSize);
        const hexName = stringToHex(key);

        let totalGasCost = 0n;
        let totalStorageCost = 0n;
        let gasLimit = 0;
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const [cost, oldChunkLength, maxFeePerBlobGas, gasFeeData] = await Promise.all([
            fileContract.upfrontPayment(),
            fileContract.countChunks(hexName),
            this.#blobUploader.getBlobGasPrice(),
            this.#blobUploader.getGasPrice(),
        ]);
        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const content = await getFileChunk(file, fileSize, i * blobDataSize, (i + MAX_BLOB_COUNT) * blobDataSize);
            const blobArr = encodeBlobs(content);
            const chunkIdArr = [];
            const chunkSizeArr = [];
            const blobHashArr = [];
            const blobHashRequestArr = [];
            for (let j = 0; j < blobArr.length; j++) {
                chunkIdArr.push(i + j);
                chunkSizeArr.push(blobDataSize);

                blobHashArr.push(this.#blobUploader.getBlobHash(blobArr[j]));
                blobHashRequestArr.push(fileContract.getChunkHash(hexName, i + j));
            }

            // check change
            if (oldChunkLength !== 0 && chunkIdArr[0] < oldChunkLength) {
                const isChange = await this.#checkChange(fileContract, blobHashArr, blobHashRequestArr);
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
                gasLimit = await fileContract.writeChunks.estimateGas(hexName, chunkIdArr, chunkSizeArr, {
                    value: value,
                    blobVersionedHashes: blobHashArr
                });
            }
            const gasCost = (gasFeeData.maxFeePerGas + gasFeeData.maxPriorityFeePerGas) * gasLimit;
            const blobGasCost = maxFeePerBlobGas * BigInt(BLOB_SIZE);
            totalGasCost += gasCost + blobGasCost;
        }

        return {
            storageCost: totalStorageCost,
            gasCost: totalGasCost
        }
    }

    // ******upload data******* /
    async upload(key, data, cb = defaultCallback) {
        let totalUploadChunks = 0;
        let totalUploadSize = 0;
        let totalStorageCost = 0n;

        const err = await this.#checkUploadStatus(key, true);
        if (err) {
            cb.onFail(err);
            cb.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const content = Buffer.from(data);
        const blobs = encodeBlobs(content);
        const blobLength = blobs.length;
        const blobDataSize = BLOB_DATA_SIZE;
        const fileSize = content.length;
        const hexName = stringToHex(key);

        // check old data
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const [cost, oldChunkLength] = await Promise.all([
            fileContract.upfrontPayment(),
            fileContract.countChunks(hexName),
        ]);
        const clearState = await this.#clearOldFile(hexName, blobLength, oldChunkLength);
        if (clearState === REMOVE_FAIL) {
            cb.onFail(new Error(`FlatDirectory: Failed to delete old data!`));
            cb.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const blobArr = [];
            const chunkIdArr = [];
            const chunkSizeArr = [];
            const blobHashArr = [];
            const blobHashRequestArr = [];
            let max = i + MAX_BLOB_COUNT > blobLength ? blobLength : i + MAX_BLOB_COUNT;
            for (let j = i; j < max; j++) {
                blobArr.push(blobs[j]);
                chunkIdArr.push(j);
                if (j === blobLength - 1) {
                    chunkSizeArr.push(fileSize - blobDataSize * (blobLength - 1));
                } else {
                    chunkSizeArr.push(blobDataSize);
                }
                blobHashArr.push(this.#blobUploader.getBlobHash(blobs[j]));
                blobHashRequestArr.push(fileContract.getChunkHash(hexName, j));
            }

            // check change
            if (clearState === REMOVE_NORMAL) {
                try {
                    const isChange = await this.#checkChange(fileContract, blobHashArr, blobHashRequestArr);
                    if (!isChange) {
                        cb.onProgress(chunkIdArr[chunkIdArr.length - 1], blobLength, false);
                        continue;
                    }
                } catch (e) {
                    cb.onFail(e);
                    break;
                }
            }

            // upload
            try {
                const status = await this.#uploadBlob(fileContract, key, hexName, blobArr, chunkIdArr, chunkSizeArr, cost);
                if (!status) {
                    cb.onFail(new Error("FlatDirectory: Sending transaction failed."));
                    break;
                }
            } catch (e) {
                cb.onFail(e);
                break;
            }
            // success
            cb.onProgress(chunkIdArr[chunkIdArr.length - 1], blobLength, true);
            totalStorageCost += cost * BigInt(blobArr.length);
            totalUploadChunks += blobArr.length;
            for (let i = 0; i < chunkSizeArr.length; i++) {
                totalUploadSize += chunkSizeArr[i];
            }
        }

        cb.onSuccess(totalUploadChunks, totalUploadSize, totalStorageCost);
    }

    async uploadFile(key, file, cb = defaultCallback) {
        let totalUploadChunks = 0;
        let totalUploadSize = 0;
        let totalStorageCost = 0n;

        const err = await this.#checkUploadStatus(key, true);
        if(err) {
            cb.onFail(err);
            cb.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const fileSize = file.size;
        const blobDataSize = BLOB_DATA_SIZE;
        const blobLength = Math.ceil(fileSize / blobDataSize);
        const hexName = stringToHex(key);

        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        // check old data
        const [cost, oldChunkLength] = await Promise.all([
            fileContract.upfrontPayment(),
            fileContract.countChunks(hexName),
        ]);
        const clearState = await this.#clearOldFile(hexName, blobLength, oldChunkLength);
        if (clearState === REMOVE_FAIL) {
            cb.onFail(new Error(`FlatDirectory: Failed to delete old data!`));
            cb.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const content = await getFileChunk(file, fileSize, i * blobDataSize, (i + MAX_BLOB_COUNT) * blobDataSize);
            const blobArr = encodeBlobs(content);
            const chunkIdArr = [];
            const chunkSizeArr = [];
            const blobHashArr = [];
            const blobHashRequestArr = [];
            for (let j = 0; j < blobArr.length; j++) {
                chunkIdArr.push(i + j);
                if (i + j === blobLength - 1) {
                    chunkSizeArr.push(fileSize - blobDataSize * (blobLength - 1));
                } else {
                    chunkSizeArr.push(blobDataSize);
                }
                blobHashArr.push(this.#blobUploader.getBlobHash(blobArr[j]));
                blobHashRequestArr.push(fileContract.getChunkHash(hexName, i + j));
            }

            // check change
            if (clearState === REMOVE_NORMAL) {
                try {
                    const isChange = await this.#checkChange(fileContract, blobHashArr, blobHashRequestArr);
                    if (!isChange) {
                        cb.onProgress(chunkIdArr[chunkIdArr.length - 1], blobLength, false);
                        continue;
                    }
                } catch (e) {
                    cb.onFail(e);
                    break;
                }
            }

            // upload
            try {
                const status = await this.#uploadBlob(fileContract, key, hexName, blobArr, chunkIdArr, chunkSizeArr, cost);
                if (!status) {
                    cb.onFail(new Error("FlatDirectory: Sending transaction failed."));
                    break;
                }
            } catch (e) {
                cb.onFail(e);
                break;
            }

            // success
            cb.onProgress(chunkIdArr[chunkIdArr.length - 1], blobLength, true);
            totalStorageCost += cost * BigInt(blobArr.length);
            totalUploadChunks += blobArr.length;
            for (let i = 0; i < chunkSizeArr.length; i++) {
                totalUploadSize += chunkSizeArr[i];
            }
        }

        cb.onFinish(totalUploadChunks, totalUploadSize, totalStorageCost);
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

    async #checkChange(fileContract, blobHashArr, blobHashRequestArr) {
        let hasChange = false;
        const dataHashArr = await Promise.all(blobHashRequestArr);
        for (let i = 0; i < blobHashArr.length; i++) {
            if (blobHashArr[i] !== dataHashArr[i]) {
                hasChange = true;
                break;
            }
        }
        return hasChange;
    }

    async #uploadBlob(fileContract, key, hexName, blobArr, chunkIdArr, chunkSizeArr, cost) {
        // create tx
        const value = cost * BigInt(blobArr.length);
        const tx = await fileContract.writeChunks.populateTransaction(hexName, chunkIdArr, chunkSizeArr, {
            value: value,
        });
        // send
        const txResponse = await this.#blobUploader.sendTxLock(tx, blobArr);
        console.log(`FlatDirectory: The ${chunkIdArr} chunks of file ${key} hash is ${txResponse.hash}.`);
        const txReceipt = await txResponse.wait();
        return txReceipt && txReceipt.status;
    }

    async #checkUploadStatus(key, isReturn) {
        if (!this.#contractAddr) {
            const err = new Error(`FlatDirectory: FlatDirectory not deployed!`);
            if (isReturn) {
                return err;
            }
            throw err;
        }

        if (!this.#isSupportBlob) {
            const err = new Error(`FlatDirectory: The contract does not support blob upload!`);
            if (isReturn) {
                return err;
            }
            throw err;
        }

        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const fileMod = await fileContract.getStorageMode(stringToHex(key));
        if (fileMod !== BigInt(VERSION_BLOB) && fileMod !== 0n) {
            const err = new Error(`FlatDirectory: This file does not support blob upload!`);
            if (isReturn) {
                return err;
            }
            throw err;
        }
        return null;
    }
}
