import { ethers } from "ethers";
import {
    SDKConfig, EstimateGasRequest, CostEstimate, UploadRequest, DownloadCallback, UploadType,
    FlatDirectoryAbi, FlatDirectoryBytecode, ETHSTORAGE_MAPPING,
    BLOB_SIZE, BLOB_DATA_SIZE, OP_BLOB_DATA_SIZE,
    MAX_BLOB_COUNT, MAX_RETRIES,
    VERSION_3, VERSION_2, VERSION_1,
    SOLC_VERSION_1_0_0, MAX_HASH_LIMIT, ContentLike,
} from './param';
import {
    BlobUploader,
    encodeBlobs, encodeOpBlobs,
    getChainId, getFileChunk, getBufferChunk,
    getHash, isBuffer, isFile,
    stringToHex, isNodejs,
    retry
} from "./utils";

import workerpool from 'workerpool';
const pool = workerpool.pool(__dirname + '/worker.cjs.js');

const REMOVE_FAIL = -1;
const REMOVE_NORMAL = 0;
const REMOVE_SUCCESS = 1;

const GALILEO_CHAIN_ID = 3334;

const defaultCallback: DownloadCallback = {
    onProgress: () => { },
    onFail: () => { },
    onFinish: () => { }
};


export class FlatDirectory {
    private ethStorageRpc?: string;
    private contractAddr!: string;
    private chainId!: number;
    private version!: number;
    private blobSize!: number;
    private retries!: number;

    private wallet!: ethers.Wallet;
    private blobUploader!: BlobUploader;

    static async create(config: SDKConfig) {
        const flatDirectory = new FlatDirectory();
        await flatDirectory.init(config);
        return flatDirectory;
    }

    private async init(config: SDKConfig) {
        const { rpc, ethStorageRpc, privateKey, address } = config;
        this.ethStorageRpc = ethStorageRpc;
        this.retries = MAX_RETRIES;

        const provider = new ethers.JsonRpcProvider(rpc);
        this.wallet = new ethers.Wallet(privateKey, provider);
        this.blobUploader = await BlobUploader.create(rpc, privateKey);
        this.chainId = await getChainId(rpc);
        if (!address) return;

        this.contractAddr = address;
        const provider = new ethers.JsonRpcProvider(rpc);
        const fileContract = new ethers.Contract(address, FlatDirectoryAbi, provider) as any;
        const [supportBlob, solcVersion] = await Promise.all([
            retry(() => fileContract.isSupportBlob(), this.retries).catch(() => false),
            retry(() => fileContract.version(), this.retries).catch(() => 0)
        ]);
        if (supportBlob) {
            this.version = solcVersion === SOLC_VERSION_1_0_0 ? VERSION_3 : VERSION_2;
            this.blobSize = solcVersion === SOLC_VERSION_1_0_0 ? OP_BLOB_DATA_SIZE : BLOB_DATA_SIZE;
        } else {
            this.version = VERSION_1;
        }
    }

    #checkAddress() {
        if (!this.contractAddr) {
            throw new Error(`FlatDirectory: FlatDirectory not deployed!`);
        }
    }

    async deploy(): Promise<string | null> {
        this.version = ETHSTORAGE_MAPPING[this.chainId] != null ? VERSION_3 : VERSION_1;
        this.blobSize = OP_BLOB_DATA_SIZE;

        const ethStorage = ETHSTORAGE_MAPPING[this.chainId] || '0x0000000000000000000000000000000000000000';
        const factory = new ethers.ContractFactory(FlatDirectoryAbi, FlatDirectoryBytecode, this.wallet);
        try {
            const contract = await factory.deploy(0, OP_BLOB_DATA_SIZE, ethStorage, { gasLimit: 3800000 });
            await contract.waitForDeployment();

            this.contractAddr = await contract.getAddress();
            console.log(`FlatDirectory: Address is ${this.contractAddr}`);
            return this.contractAddr;
        } catch (e) {
            console.error(`FlatDirectory: Deploy FlatDirectory failed!`, (e as { message?: string }).message || e);
            return null;
        }
    }

    async setDefault(filename: string): Promise<boolean> {
        this.#checkAddress();

        const hexName = filename ? stringToHex(filename) : "0x";
        const fileContract = new ethers.Contract(this.contractAddr, FlatDirectoryAbi, this.wallet) as any;
        try {
            const tx = await fileContract.setDefault(hexName);
            console.log(`FlatDirectory: Tx hash is ${tx.hash}`);
            const txReceipt = await tx.wait();
            return txReceipt.status === 1;
        } catch (e) {
            console.error(`FlatDirectory: Set default file failed!`, (e as { message?: string }).message || e);
        }
        return false;
    }

    async remove(key: string): Promise<boolean> {
        this.#checkAddress();

        const fileContract = new ethers.Contract(this.contractAddr, FlatDirectoryAbi, this.wallet) as any;
        try {
            const tx = await fileContract.remove(stringToHex(key));
            console.log(`FlatDirectory: Tx hash is ${tx.hash}`);
            const receipt = await tx.wait();
            return receipt.status === 1;
        } catch (e) {
            console.error(`FlatDirectory: Failed to remove file: ${key}`, (e as { message?: string }).message || e);
        }
        return false;
    }

    async download(key: string, cb: DownloadCallback = defaultCallback) {
        this.#checkAddress();
        if (!this.ethStorageRpc) {
            throw new Error(`FlatDirectory: Reading content requires providing 'ethStorageRpc'.`);
        }

        const hexName = stringToHex(key);
        const provider = new ethers.JsonRpcProvider(this.ethStorageRpc);
        const contract = new ethers.Contract(this.contractAddr, FlatDirectoryAbi, provider) as any;
        try {
            const blobCount = await this.countChunks(contract, hexName);
            for (let i = 0; i < blobCount; i++) {
                const result = await contract.readChunk(hexName, i);
                const chunk = ethers.getBytes(result[0]);
                cb.onProgress(i, blobCount, Buffer.from(chunk));
            }
        } catch (e) {
            cb.onFail(e);
        }
        cb.onFinish();
    }

    async estimateCost(request: EstimateGasRequest): Promise<CostEstimate> {
        this.#checkAddress();

        const { key, type } = request;
        if (!key) {
            throw new Error(`FlatDirectory: Invalid key!`);
        }

        if (type === UploadType.Blob) {
            return await this.estimateCostByBlob(request);
        } else {
            return await this.estimateCostByCallData(request);
        }
    }

    async upload(request: UploadRequest): Promise<void> {
        const { key, callback, type } = request;
        if (!callback) {
            throw new Error(`FlatDirectory: Invalid callback object!`);
        }
        if (!key) {
            callback.onFail!(new Error(`FlatDirectory: Invalid key!`));
            callback.onFinish!(0, 0, 0n);
            return;
        }
        if (!this.contractAddr) {
            callback.onFail!(new Error(`FlatDirectory: FlatDirectory not deployed!`));
            callback.onFinish!(0, 0, 0n);
            return;
        }

        if (type === UploadType.Blob) {
            await this.uploadByBlob(request);
        } else {
            await this.uploadByCallData(request);
        }
    }

    private async estimateCostByBlob(request: EstimateGasRequest): Promise<CostEstimate> {
        const { key, content, gasIncPct = 0 } = request;

        if (this.version === VERSION_1) {
            throw new Error(`FlatDirectory: The contract does not support blob upload!`);
        }

        const blobLength = this.getBlobLength(content);
        if (blobLength === -1) {
            throw new Error(`FlatDirectory: Invalid upload content!`);
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.contractAddr, FlatDirectoryAbi, this.wallet) as any;
        const [cost, oldBlobLength, maxFeePerBlobGas, gasFeeData, fileMod] = await Promise.all([
            retry(() => fileContract.upfrontPayment(), this.retries),
            retry(() => this.countChunks(fileContract, hexName), this.retries),
            retry(() => this.blobUploader.getBlobGasPrice(), this.retries),
            retry(() => this.blobUploader.getGasPrice(), this.retries),
            retry(() => fileContract.getStorageMode(hexName), this.retries)
        ]);

        if (fileMod !== BigInt(UploadType.Blob) && fileMod !== BigInt(UploadType.Undefined)) {
            throw new Error("FlatDirectory: This file does not support blob upload!");
        }

        // batch get old data hash
        let oldHashArr:string[] = [];
        if (oldBlobLength > 0 && blobLength >= oldBlobLength) {
            oldHashArr = await this.getHashesFromContract(fileContract, hexName, oldBlobLength);
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
            } = await this.getBlobInfo(content, blobLength, i);

            let blobHashArr: string[];
            // check change
            if (i + blobArr.length <= oldHashArr.length) {
                blobHashArr = await this.getBlobHashes(blobArr);
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
                blobHashArr = blobHashArr ? blobHashArr : await this.getBlobHashes(blobArr);
                gasLimit = await retry(() => fileContract.writeChunks.estimateGas(hexName, chunkIdArr, chunkSizeArr, {
                    value: value,
                    blobVersionedHashes: blobHashArr
                }), this.retries);
            }
            const gasCost = (gasFeeData.maxFeePerGas! + gasFeeData.maxPriorityFeePerGas!) * BigInt(gasLimit)
                + maxFeePerBlobGas * BigInt(BLOB_SIZE);
            totalGasCost += gasCost;
        }

        totalGasCost += (totalGasCost * BigInt(gasIncPct)) / 100n;
        return {
            storageCost: totalStorageCost,
            gasCost: totalGasCost
        }
    }

    private async estimateCostByCallData(request: EstimateGasRequest): Promise<CostEstimate> {
        const { key, content, gasIncPct = 0 } = request;

        const {chunkDataSize, chunkLength} = this.getChunkLength(content);
        if (chunkDataSize === -1) {
            throw new Error(`FlatDirectory: Invalid upload content!`);
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.contractAddr, FlatDirectoryAbi, this.wallet) as any;
        const [oldChunkLength, gasFeeData, fileMod] = await Promise.all([
            retry(() => this.countChunks(fileContract, hexName), this.retries),
            retry(() => this.blobUploader.getGasPrice(), this.retries),
            retry(() => fileContract.getStorageMode(hexName), this.retries)
        ]);

        if (fileMod !== BigInt(UploadType.Blob) && fileMod !== BigInt(UploadType.Undefined)) {
            throw new Error(`FlatDirectory: This file does not support calldata upload!`);
        }

        // batch get old data hash
        let oldHashArr = [];
        if (oldChunkLength > 0 && chunkLength >= oldChunkLength) {
            oldHashArr = await this.getHashesFromContract(fileContract, hexName, oldChunkLength);
        }

        let totalStorageCost = 0n;
        let totalGasCost = 0n;
        let gasLimit = 0n;
        for (let i = 0; i < chunkLength; i++) {
            const chunk = isBuffer(content) ? getBufferChunk(content, content.length, i * chunkDataSize, (i + 1) * chunkDataSize) :
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
                const value = Math.floor((chunk.length + 326) / 1024 / 24);
                cost = ethers.parseEther(value.toString());
            }
            if (i === chunkLength - 1 || gasLimit === 0n) {
                const hexData = ethers.hexlify(chunk);
                gasLimit = await retry(() => fileContract.writeChunk.estimateGas(hexName, 0, hexData, {value: cost}), this.retries);
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

    private async uploadByBlob(request: UploadRequest): Promise<void> {
        let totalUploadChunks = 0;
        let totalUploadSize = 0;
        let totalStorageCost = 0n;

        const { key, content, callback, gasIncPct = 0 } = request;
        if (this.version === VERSION_1) {
            callback.onFail?.(new Error(`FlatDirectory: The contract does not support blob upload!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const blobLength = this.getBlobLength(content);
        if (blobLength === -1) {
            callback.onFail?.(new Error(`FlatDirectory: Invalid upload content!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.contractAddr, FlatDirectoryAbi, this.wallet) as any;
        const [cost, oldBlobLength, fileMod] = await Promise.all([
            retry(() => fileContract.upfrontPayment(), this.retries),
            retry(() => this.countChunks(fileContract, hexName), this.retries),
            retry(() => fileContract.getStorageMode(hexName), this.retries)
        ]);

        if (fileMod !== BigInt(UploadType.Blob) && fileMod !== BigInt(UploadType.Undefined)) {
            callback.onFail?.(new Error(`FlatDirectory: This file does not support blob upload!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const clearState = await retry(() => this.clearOldFile(hexName, blobLength, oldBlobLength), this.retries);
        if (clearState === REMOVE_FAIL) {
            callback.onFail?.(new Error(`FlatDirectory: Failed to delete old data!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        let oldHashArr: string[] = [];
        if (clearState === REMOVE_NORMAL) {
            oldHashArr = await this.getHashesFromContract(fileContract, hexName, oldBlobLength);
        }

        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const {
                blobArr,
                chunkIdArr,
                chunkSizeArr
            } = await this.getBlobInfo(content, blobLength, i);
            const blobCommitmentArr = await this.getBlobCommitments(blobArr);

            // check change
            if (i + blobArr.length <= oldHashArr.length) {
                const localHashArr = this.getHashes(blobCommitmentArr);
                const cloudHashArr = oldHashArr.slice(i, i + localHashArr.length);
                if (JSON.stringify(localHashArr) === JSON.stringify(cloudHashArr)) {
                    callback.onProgress?.(chunkIdArr[chunkIdArr.length - 1], blobLength, false);
                    continue;
                }
            }

            const status = await retry(() => this.uploadBlob(fileContract, key, hexName, blobArr, blobCommitmentArr, chunkIdArr, chunkSizeArr, cost, gasIncPct), this.retries);
            if (!status) {
                callback.onFail?.(new Error("FlatDirectory: Sending transaction failed."));
                break;
            }

            callback.onProgress?.(chunkIdArr[chunkIdArr.length - 1], blobLength, true);
            totalStorageCost += cost * BigInt(blobArr.length);
            totalUploadChunks += blobArr.length;
            totalUploadSize += chunkSizeArr.reduce((acc, size) => acc + size, 0);
        }

        callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
    }

    private async uploadByCallData(request: UploadRequest): Promise<void> {
        let totalUploadChunks = 0;
        let totalUploadSize = 0;
        let totalStorageCost = 0n;

        const { key, content, callback, gasIncPct = 0 } = request;
        const { chunkDataSize, chunkLength } = this.getChunkLength(content);
        if (chunkDataSize === -1) {
            callback.onFail?.(new Error(`FlatDirectory: Invalid upload content!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.contractAddr!, FlatDirectoryAbi, this.wallet) as any;
        const [oldChunkLength, fileMod] = await Promise.all([
            retry(() => this.countChunks(fileContract, hexName), this.retries),
            retry(() => fileContract.getStorageMode(hexName), this.retries)
        ]);

        if (fileMod !== BigInt(UploadType.Calldata) && fileMod !== BigInt(UploadType.Undefined)) {
            callback.onFail?.(new Error(`FlatDirectory: This file does not support calldata upload!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const clearState = await retry(() => this.clearOldFile(hexName, chunkLength, oldChunkLength), this.retries);
        if (clearState === REMOVE_FAIL) {
            callback.onFail?.(new Error(`FlatDirectory: Failed to delete old data!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        let oldHashArr: string[] = [];
        if (clearState === REMOVE_NORMAL) {
            oldHashArr = await this.getHashesFromContract(fileContract, hexName, oldChunkLength);
        }

        for (let i = 0; i < chunkLength; i++) {
            const chunk = isBuffer(content) ? getBufferChunk(content, content.length, i * chunkDataSize, (i + 1) * chunkDataSize) :
                await getFileChunk(content, content.size, i * chunkDataSize, (i + 1) * chunkDataSize);

            if (i < oldHashArr.length) {
                if (ethers.keccak256(chunk) === oldHashArr[i]) {
                    callback.onProgress?.(i, chunkLength, false);
                    continue;
                }
            }

            const status = await retry(() => this.uploadCallData(fileContract, key, hexName, i, chunk, gasIncPct), this.retries);
            if (!status) {
                callback.onFail?.(new Error("FlatDirectory: Sending transaction failed."));
                break;
            }

            const cost = chunk.length > 24 * 1024 - 326 ? BigInt(Math.floor((chunk.length + 326) / 1024 / 24)) : 0n;
            callback.onProgress?.(i, chunkLength, true);
            totalStorageCost += cost;
            totalUploadChunks++;
            totalUploadSize += chunk.length;
        }

        callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
    }

    private async clearOldFile(key: string, chunkLength: number, oldChunkLength: number): Promise<number> {
        if (oldChunkLength > chunkLength) {
            // remove
            const v = await this.remove(key);
            return v ? REMOVE_SUCCESS : REMOVE_FAIL;
        } else if (oldChunkLength === 0) {
            return REMOVE_SUCCESS;
        } else {
            return REMOVE_NORMAL;
        }
    }

    private async uploadBlob(
        fileContract: any,
        key: string,
        hexName: string,
        blobArr: Uint8Array[],
        blobCommitmentArr: Uint8Array[],
        chunkIdArr: number[],
        chunkSizeArr: number[],
        cost: bigint,
        gasIncPct: number
    ): Promise<boolean> {
        const value = cost * BigInt(blobArr.length);
        const tx = await fileContract.writeChunks.populateTransaction(hexName, chunkIdArr, chunkSizeArr, { value });

        if (gasIncPct > 0) {
            const feeData = await this.blobUploader.getGasPrice();
            tx.maxFeePerGas = feeData.maxFeePerGas * BigInt(100 + gasIncPct) / BigInt(100);
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * BigInt(100 + gasIncPct) / BigInt(100);
            // blob gas
            const blobGas = await this.blobUploader.getBlobGasPrice();
            tx.maxFeePerBlobGas = blobGas * BigInt(100 + gasIncPct) / BigInt(100);
        }
        // send
        const txResponse = await this.blobUploader.sendTxLock(tx, blobArr, blobCommitmentArr);
        this.printHashLog(key, chunkIdArr, txResponse.hash);
        const txReceipt = await txResponse.wait();
        return txReceipt?.status === 1;
    }

    private async uploadCallData(
        fileContract: any,
        key: string,
        hexName: string,
        chunkId: number,
        chunk: Uint8Array,
        gasIncPct: number
    ): Promise<boolean | undefined> {
        const hexData = ethers.hexlify(chunk);
        const cost = chunk.length > 24 * 1024 - 326 ? BigInt(Math.floor((chunk.length + 326) / 1024 / 24)) : 0n;
        const tx = await fileContract.writeChunk.populateTransaction(hexName, chunkId, hexData, {
            value: ethers.parseEther(cost.toString())
        });
        // Increase % if user requests it
        if (gasIncPct > 0) {
            const feeData = await this.blobUploader.getGasPrice();
            tx.maxFeePerGas = feeData.maxFeePerGas * BigInt(100 + gasIncPct) / BigInt(100);
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * BigInt(100 + gasIncPct) / BigInt(100);
        }

        // send
        const txResponse = await this.blobUploader.sendTxLock(tx);
        this.printHashLog(key, chunkId, txResponse.hash);
        const txReceipt = await txResponse.wait();
        return txReceipt?.status === 1;
    }

    private async countChunks(fileContract: any, hexName: string): Promise<number> {
        const count = await fileContract.countChunks(hexName);
        // Bigint to number
        return Number(count);
    }

    private async getBlobCommitments(blobArr: Uint8Array[]): Promise<Uint8Array[]> {
        const promises = isNodejs()
            ? blobArr.map(blob => pool.exec('getCommitment', [blob]))
            : blobArr.map(blob => this.blobUploader.getCommitment(blob));
        return await Promise.all(promises);
    }

    private getHashes(blobCommitmentArr: Uint8Array[]): string[] {
        return blobCommitmentArr.map(comment => getHash(comment));
    }

    private async getBlobHashes(blobArr: Uint8Array[]): Promise<string[]> {
        const commitments = await this.getBlobCommitments(blobArr);
        return this.getHashes(commitments);
    }

    private getBlobLength(content: ContentLike): number {
        let blobLength = -1;
        if (isFile(content)) {
            blobLength = Math.ceil(content.size / this.blobSize);
        } else if (isBuffer(content)) {
            blobLength = Math.ceil(content.length / this.blobSize);
        }
        return blobLength;
    }

    private async getBlobInfo(
        content: ContentLike,
        blobLength: number,
        index: number
    ): Promise<{ blobArr: Uint8Array[]; chunkIdArr: number[]; chunkSizeArr: number[] }> {
        const data = isBuffer(content)
            ? getBufferChunk(content, content.length, index * this.blobSize, (index + MAX_BLOB_COUNT) * this.blobSize)
            : await getFileChunk(content, content.size, index * this.blobSize, (index + MAX_BLOB_COUNT) * this.blobSize);
        const blobArr = this.version === VERSION_3 ? encodeOpBlobs(data) : encodeBlobs(data);
        const chunkIdArr: number[] = [];
        const chunkSizeArr: number[] = [];
        for (let j = 0; j < blobArr.length; j++) {
            chunkIdArr.push(index + j);
            if (index + j === blobLength - 1) {
                const size = isBuffer(content) ? content.length : content.size;
                chunkSizeArr.push(size - this.blobSize * (blobLength - 1));
            } else {
                chunkSizeArr.push(this.blobSize);
            }
        }
        return { blobArr, chunkIdArr, chunkSizeArr };
    }

    private getChunkLength(content: ContentLike): { chunkDataSize: number; chunkLength: number } {
        let chunkDataSize = -1;
        let chunkLength = 1;
        if (isFile(content)) {
            chunkDataSize = content.size;
            if (GALILEO_CHAIN_ID === this.chainId) {
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
            if (GALILEO_CHAIN_ID === this.chainId) {
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
        return { chunkDataSize, chunkLength };
    }

    private printHashLog(key: string, chunkIds: number | number[], hash: string): void {
        if (Array.isArray(chunkIds) && chunkIds.length > 1) {
            console.log(`FlatDirectory: The transaction hash for chunks ${chunkIds} is ${hash}`, "", key);
        } else {
            console.log(`FlatDirectory: The transaction hash for chunk ${chunkIds} is ${hash}`, "", key);
        }
    }

    private async getHashesFromContract(fileContract: ethers.Contract, hexName: string, oldBlobLength: number): Promise<string[]> {
        const hashPromises = [];
        for (let i = 0; i < oldBlobLength; i += MAX_HASH_LIMIT) {
            const max = Math.min(i + MAX_HASH_LIMIT, oldBlobLength);
            const chunkIdArr = [];
            for (let j = i; j < max; j++) {
                chunkIdArr.push(j);
            }
            hashPromises.push(this.chunkHashes(fileContract, hexName, chunkIdArr));
        }
        const allHashes = await Promise.all(hashPromises);
        return allHashes.flat();
    }

    private async chunkHashes(fileContract: any, hexName: string, chunkIdArr: number[]): Promise<string[]> {
        if (this.version === VERSION_3) {
            return await retry(() => fileContract.getChunkHashes(hexName, chunkIdArr), this.retries);
        }

        // old
        const blobHashRequestArr = chunkIdArr.map(id => fileContract.getChunkHash(hexName, id));
        return await retry(() => Promise.all(blobHashRequestArr), this.retries);
    }
}
