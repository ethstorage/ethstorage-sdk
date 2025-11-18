import pLimit from 'p-limit';
import { ethers } from "ethers";
import {
    SDKConfig, EstimateGasRequest, UploadRequest, CostEstimate,
    DownloadCallback, UploadType, ContentLike, FileBatch,
    ChunkCountResult, ChunkHashResult, UploadDetails,
    UploadCallback,
    FlatDirectoryAbi, FlatDirectoryBytecode, ETHSTORAGE_MAPPING,
    BLOB_SIZE, OP_BLOB_DATA_SIZE,
    MAX_BLOB_COUNT, MAX_RETRIES, MAX_CHUNKS,
    FLAT_DIRECTORY_CONTRACT_VERSION_1_0_0,
    FLAT_DIRECTORY_CONTRACT_VERSION_1_1_0,
    DUMMY_VERSIONED_COMMITMENT_HASH
} from './param';
import {
    BlobUploader,
    encodeOpBlobs,
    getChainId,
    isBuffer, isFile,
    stringToHex,
    retry, getContentChunk,
    getUploadInfo, getChunkCounts,
    getChunkHashes, convertToEthStorageHashes,
} from "./utils";

const defaultCallback: DownloadCallback = {
    onProgress: () => { },
    onFail: () => { },
    onFinish: () => { }
};

export class FlatDirectory {
    private rpc?: string;
    private ethStorageRpc?: string;
    private contractAddr?: string;

    private wallet?: ethers.Wallet;
    private blobUploader?: BlobUploader;

    private retries: number = MAX_RETRIES;
    public isSupportBlob: boolean = false;

    private logEnabled: boolean = true;

    static async create(config: SDKConfig) {
        const flatDirectory = new FlatDirectory();
        await flatDirectory.init(config);
        return flatDirectory;
    }

    setLogEnabled(value: boolean) {
        this.logEnabled = value;
    }

    async init(config: SDKConfig) {
        const { privateKey, rpc, address, ethStorageRpc } = config;
        this.rpc = rpc;
        this.contractAddr = address;
        this.ethStorageRpc = ethStorageRpc;

        if (privateKey && rpc) {
            // normal
            const provider = new ethers.JsonRpcProvider(rpc);
            this.wallet = new ethers.Wallet(privateKey, provider);
            this.blobUploader = new BlobUploader(rpc, privateKey);
            if (!address) return;
        } else if (!ethStorageRpc || !address) {
            // check is read-only mode?
            throw new Error("FlatDirectory: Read-only mode requires both 'ethStorageRpc' and 'address'");
        }

        // check solidity version
        const localRpc = rpc || ethStorageRpc;
        const provider = new ethers.JsonRpcProvider(localRpc!);
        const fileContract = new ethers.Contract(address, FlatDirectoryAbi, provider);
        const [supportBlob, contractVersion] = await Promise.all([
            retry(() => fileContract["isSupportBlob"](), this.retries).catch((e) => {
                if (e?.code === 'BAD_DATA') return false;
                throw e;
            }),
            retry(() => fileContract["version"](), this.retries).catch((e) => {
                if (e?.code === 'BAD_DATA') return "0";
                throw e;
            })
        ]);
        if (contractVersion !== FLAT_DIRECTORY_CONTRACT_VERSION_1_1_0) {
            // Release the worker, otherwise the SDK creation fails, but the worker still exists.
            await this.close();

            let sdkSuggestion: string;
            if (contractVersion === FLAT_DIRECTORY_CONTRACT_VERSION_1_0_0) {
                sdkSuggestion = "SDK v3.x";
            } else {
                sdkSuggestion = "SDK v2.x or below";
            }
            throw new Error(
                `FlatDirectory: The current SDK no longer supports this contract version (${contractVersion}).\n` +
                `Please either:\n` +
                `  1) Deploy a new compatible contract, or\n` +
                `  2) Use ${sdkSuggestion} to interact with this contract.`
            );
        }
        this.isSupportBlob = supportBlob as boolean;
    }

    async deploy(): Promise<string | null> {
        const chainId = await getChainId(this._rpc);
        this.isSupportBlob = ETHSTORAGE_MAPPING[chainId] != null;

        const ethStorage = ETHSTORAGE_MAPPING[chainId] || '0x0000000000000000000000000000000000000000';
        const factory = new ethers.ContractFactory(FlatDirectoryAbi, FlatDirectoryBytecode, this._wallet);
        try {
            // @ts-ignore
            const contract = await factory.deploy(0, OP_BLOB_DATA_SIZE, ethStorage, {gasLimit: 3800000});
            await contract.waitForDeployment();

            this.contractAddr = await contract.getAddress();
            this.#log(`Contract deployed successfully. Address is ${this.contractAddr}`);
            return this.contractAddr;
        } catch (e) {
            this.#log(`Deployment failed! ${(e as any).message || e}`, true);
            return null;
        }
    }

    async setDefault(filename: string): Promise<boolean> {
        const hexName = filename ? stringToHex(filename) : "0x";
        const fileContract = new ethers.Contract(this._contractAddr, FlatDirectoryAbi, this._wallet) as any;
        try {
            const tx = await fileContract.setDefault(hexName);
            this.#log(`Setting default file (Key: ${filename}). Transaction sent (Hash: ${tx.hash})`);
            const txReceipt = await tx.wait();
            return txReceipt.status === 1;
        } catch (e) {
            this.#log(`Failed to set default file (Key: ${filename}). ${(e as any).message || e}`, true);
        }
        return false;
    }

    async remove(key: string): Promise<boolean> {
        const fileContract = new ethers.Contract(this._contractAddr, FlatDirectoryAbi, this._wallet) as any;
        try {
            const tx = await fileContract.remove(stringToHex(key));
            this.#log(`File removal initiated (Key: ${key}). Hash: ${tx.hash}`);
            const receipt = await tx.wait();
            return receipt.status === 1;
        } catch (e) {
            this.#log(`Failed to remove file (Key: ${key}). ${(e as any).message || e}`, true);
        }
        return false;
    }

    async download(key: string, cb: DownloadCallback = defaultCallback) {
        const hexName = stringToHex(key);
        const provider = new ethers.JsonRpcProvider(this._ethStorageRpc);
        const contract = new ethers.Contract(this._contractAddr, FlatDirectoryAbi, provider);
        try {
            const result = await getChunkCounts(contract, [key], this.retries);
            const totalChunks = result[0].chunkCount;
            if (totalChunks === 0) {
                cb.onFinish();
                return;
            }

            await this.#download(contract, hexName, totalChunks, cb);
            cb.onFinish();
        } catch (err) {
            cb.onFail(err as Error);
        }
    }

    async fetchHashes(keys: string[]): Promise<Record<string, string[]>> {
        if (!keys || !Array.isArray(keys)) {
            throw new Error('Invalid keys.');
        }

        // get file chunks
        const contract = new ethers.Contract(this._contractAddr, FlatDirectoryAbi, this._wallet);
        const fileInfos = await getChunkCounts(contract, keys, this.retries);
        return this.#fetchHashes(fileInfos);
    }

    async estimateCost(request: EstimateGasRequest): Promise<CostEstimate> {
        const { key, type } = request;
        if (!key) {
            throw new Error(`FlatDirectory: Invalid key!`);
        }

        if (type === UploadType.Blob) {
            return await this.#estimateCostByBlob(request);
        } else {
            return await this.#estimateCostByCallData(request);
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
        if (!this.wallet) {
            callback.onFail!(new Error(`FlatDirectory: Private key is required for this operation.`));
            callback.onFinish!(0, 0, 0n);
            return;
        }

        if (type === UploadType.Blob) {
            await this.#uploadByBlob(request);
        } else {
            await this.#uploadByCallData(request);
        }
    }

    async close(): Promise<void> {
        if (this.blobUploader) {
            await this.blobUploader.close();
        }
    }


    // private method
    async #download(
        contract: ethers.Contract,
        hexName: string,
        totalChunks: number,
        cb: DownloadCallback
    ) {
        // Ordered cache + sequential callback
        const downloadedResults = new Map<number, Uint8Array>();
        let nextCallbackStart = 0;
        const flushReadyChunks = () => {
            while (downloadedResults.has(nextCallbackStart)) {
                const data = downloadedResults.get(nextCallbackStart)!;
                cb.onProgress(nextCallbackStart, totalChunks, data);
                downloadedResults.delete(nextCallbackStart);
                nextCallbackStart++;
            }
        };

        const fetchSingle = async (i: number) => {
            const [data] = await contract['readChunk'](hexName, i);
            downloadedResults.set(i, ethers.getBytes(data));
            flushReadyChunks();
        };

        // download task
        let DEFAULT_MAX_CONCURRENCY: number;
        if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
            DEFAULT_MAX_CONCURRENCY = 6;
        } else if (typeof process !== 'undefined' && process.versions?.node) {
            try {
                const os = await import('os');
                const cores = os.cpus().length;
                DEFAULT_MAX_CONCURRENCY = Math.max(2, Math.min(20, cores * 2));
            } catch (err) {
                DEFAULT_MAX_CONCURRENCY = 10;
            }
        } else {
            DEFAULT_MAX_CONCURRENCY = 6;
        }
        const limit = pLimit(DEFAULT_MAX_CONCURRENCY);
        const quests = Array.from({ length: totalChunks }, (_, i) =>
                limit(() => retry(() => fetchSingle(i), this.retries))
            );

        await Promise.all(quests);
        await new Promise(r => setTimeout(r, 0));
        flushReadyChunks(); // flush any remaining pages
    }

    async #fetchHashes(fileInfos: ChunkCountResult[]): Promise<Record<string, string[]>> {
        const allHashes: Record<string, string[]> = {};

        const batchArray: Record<string, number[]>[] = [];
        let currentBatch: Record<string, number[]> = {};
        let currentChunkCount = 0;
        for (const { key, chunkCount } of fileInfos) {
            allHashes[key] = chunkCount === 0 ? [] : new Array(chunkCount);

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
        if (batchArray.length > 0) {
            const contract = new ethers.Contract(this.contractAddr!, FlatDirectoryAbi, this.wallet!);
            const hashResults = await Promise.all(batchArray.map(batch => {
                const fileChunksArray: FileBatch[] = Object.keys(batch).map(name => ({
                    name,
                    chunkIds: batch[name]
                }));
                return getChunkHashes(contract, fileChunksArray, this.retries);
            }));
            // Combine results
            hashResults.flat().forEach(({ name, chunkId, hash }: ChunkHashResult) => {
                allHashes[name][chunkId] = hash;
            });
        }
        return allHashes;
    }

    async #estimateCostByBlob(request: EstimateGasRequest): Promise<CostEstimate> {
        let { key, content, chunkHashes, gasIncPct = 0 } = request;

        if (!this.isSupportBlob) {
            throw new Error(`FlatDirectory: The contract does not support blob upload!`);
        }

        // check data
        const blobLength = this.#getBlobLength(content);
        if (blobLength === -1) {
            throw new Error(`FlatDirectory: Invalid upload content!`);
        }

        // get file info
        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this._contractAddr, FlatDirectoryAbi, this._wallet);
        const { cost, oldChunkCount, fileMode, maxFeePerBlobGas, gasFeeData } = await this.#getEstimateBlobInfo(fileContract, hexName);
        if (fileMode !== UploadType.Blob && fileMode !== UploadType.Undefined) {
            throw new Error("FlatDirectory: This file does not support blob upload!");
        }

        // Get old chunk hashes, If the chunk hashes is not passed, it is obtained here
        if (!chunkHashes) {
            const hashes = await this.#fetchHashes([{ key, chunkCount: oldChunkCount }]);
            chunkHashes = hashes[key];
        }

        let totalGasCost = 0n;
        let totalStorageCost = 0n;
        let gasLimit = 0n;
        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const { blobArr, chunkIdArr, chunkSizeArr } = await this.#getBlobInfo(content, i);

            let blobHashArr: string[] | null = null;
            // not change
            if (i + blobArr.length <= chunkHashes.length) {
                blobHashArr = await this._blobUploader.computeEthStorageHashesForBlobs(blobArr);
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
            if (gasLimit === 0n) {
                // Use a fixed dummy versioned hash only if blobHashArr is not provided (for gas estimation compatibility).
                gasLimit = await retry(() => fileContract["writeChunksByBlobs"].estimateGas(hexName, chunkIdArr, chunkSizeArr, {
                    value: value,
                    blobVersionedHashes: new Array(blobArr.length).fill(DUMMY_VERSIONED_COMMITMENT_HASH)
                }), this.retries);
            }
            const gasCost = (gasFeeData!.maxFeePerGas! + gasFeeData!.maxPriorityFeePerGas!) * BigInt(gasLimit)
                + maxFeePerBlobGas! * BigInt(BLOB_SIZE);
            totalGasCost += gasCost;
        }

        totalGasCost += (totalGasCost * BigInt(gasIncPct)) / 100n;
        return {
            storageCost: totalStorageCost,
            gasCost: totalGasCost
        }
    }

    async #estimateCostByCallData(request: EstimateGasRequest): Promise<CostEstimate> {
        let { key, content, chunkHashes, gasIncPct = 0 } = request;

        const { chunkDataSize, chunkLength } = this.#getChunkLength(content);
        if (chunkDataSize === -1) {
            throw new Error(`FlatDirectory: Invalid upload content!`);
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this._contractAddr, FlatDirectoryAbi, this._wallet) as any;
        const { oldChunkCount, fileMode, gasFeeData } = await this.#getEstimateCallDataInfo(fileContract, hexName);
        if (fileMode !== UploadType.Calldata && fileMode !== UploadType.Undefined) {
            throw new Error(`FlatDirectory: This file does not support calldata upload!`);
        }

        // Get old chunk hashes, If the chunk hashes is not passed, it is obtained here
        if (!chunkHashes) {
            const hashes = await this.#fetchHashes([{ key, chunkCount: oldChunkCount }]);
            chunkHashes = hashes[key];
        }

        let totalGasCost = 0n;
        let gasLimit = 0n;
        for (let i = 0; i < chunkLength; i++) {
            const chunk = await getContentChunk(content, i * chunkDataSize, (i + 1) * chunkDataSize);

            // not change
            if (i < chunkHashes.length && ethers.keccak256(chunk) === chunkHashes[i]) {
                continue;
            }

            // get gas cost
            if (i === chunkLength - 1 || gasLimit === 0n) {
                const hexData = ethers.hexlify(chunk);
                gasLimit = await retry(() => fileContract["writeChunkByCalldata"].estimateGas(hexName, 0, hexData), this.retries);
            }
            totalGasCost += (gasFeeData!.maxFeePerGas! + gasFeeData!.maxPriorityFeePerGas!) * gasLimit;
        }
        totalGasCost += (totalGasCost * BigInt(gasIncPct)) / 100n;

        return {
            storageCost: 0n,
            gasCost: totalGasCost
        }
    }

    async #uploadByBlob(request: UploadRequest): Promise<void> {
        let totalUploadChunks = 0, totalUploadSize = 0;
        let totalCost = 0n;

        let { key, content, callback, chunkHashes, gasIncPct = 0, isConfirmedNonce = false } = request;
        if (!this.isSupportBlob) {
            callback.onFail?.(new Error(`FlatDirectory: The contract does not support blob upload!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalCost);
            return;
        }

        const blobLength = this.#getBlobLength(content);
        if (blobLength === -1) {
            callback.onFail?.(new Error(`FlatDirectory: Invalid upload content!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalCost);
            return;
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.contractAddr!, FlatDirectoryAbi, this.wallet!);
        const { cost, oldChunkCount, fileMode } = await this.#getUploadInfo(fileContract, hexName);
        if (fileMode !== UploadType.Blob && fileMode !== UploadType.Undefined) {
            callback.onFail!(new Error(`FlatDirectory: This file does not support blob upload!`));
            callback.onFinish!(totalUploadChunks, totalUploadSize, totalCost);
            return;
        }

        const clearState = await retry(() => this.#clearOldFile(fileContract, hexName, blobLength, oldChunkCount), this.retries);
        if (!clearState) {
            callback.onFail!(new Error(`FlatDirectory: Failed to truncate old data!`));
            callback.onFinish!(totalUploadChunks, totalUploadSize, totalCost);
            return;
        }

        // Get old chunk hashes, If the chunk hashes is not passed, it is obtained here
        if (!chunkHashes) {
            const hashes = await this.#fetchHashes([{ key, chunkCount: oldChunkCount }]);
            chunkHashes = hashes[key];
        }

        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const {
                blobArr, chunkIdArr, chunkSizeArr
            } = await this.#getBlobInfo(content, i);
            const blobCommitmentArr = await this._blobUploader.computeCommitmentsForBlobs(blobArr);

            // not change
            if (i + blobArr.length <= chunkHashes.length) {
                const localHashArr = convertToEthStorageHashes(blobCommitmentArr);
                const cloudHashArr = chunkHashes.slice(i, i + localHashArr.length);
                if (JSON.stringify(localHashArr) === JSON.stringify(cloudHashArr)) {
                    callback.onProgress!(chunkIdArr[chunkIdArr.length - 1], blobLength, false);
                    continue;
                }
            }

            // upload
            const txResponse = await retry(() => this.#uploadBlob(fileContract, key, hexName, blobArr,
                blobCommitmentArr, chunkIdArr, chunkSizeArr, cost, gasIncPct, isConfirmedNonce, callback as UploadCallback), this.retries);
            const uploadResult = await retry(() => this._blobUploader.getTransactionResult(txResponse.hash), this.retries);

            // Count tx costs, regardless of success or failure.
            totalCost += cost * BigInt(blobArr.length); // storage cost
            totalCost += uploadResult.txCost.normalGasCost + uploadResult.txCost.blobGasCost;

            // fail
            if (!uploadResult.success) {
                callback.onFail!(new Error("FlatDirectory: Sending transaction failed."));
                break;
            }
            // success
            callback.onProgress!(chunkIdArr[chunkIdArr.length - 1], blobLength, true);
            totalUploadChunks += blobArr.length;
            totalUploadSize += chunkSizeArr.reduce((acc: number, size: number) => acc + size, 0);
        }

        callback.onFinish!(totalUploadChunks, totalUploadSize, totalCost);
    }

    async #uploadByCallData(request: UploadRequest): Promise<void> {
        let totalUploadChunks = 0, totalUploadSize = 0;
        let totalCost = 0n;

        let { key, content, callback, chunkHashes, gasIncPct = 0, isConfirmedNonce = false } = request;

        const { chunkDataSize, chunkLength } = this.#getChunkLength(content);
        if (chunkDataSize === -1) {
            callback.onFail!(new Error(`FlatDirectory: Invalid upload content!`));
            callback.onFinish!(totalUploadChunks, totalUploadSize, totalCost);
            return;
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.contractAddr!, FlatDirectoryAbi, this.wallet!);
        const { oldChunkCount, fileMode } = await this.#getUploadInfo(fileContract, hexName);
        if (fileMode !== UploadType.Calldata && fileMode !== UploadType.Undefined) {
            callback.onFail!(new Error(`FlatDirectory: This file does not support calldata upload!`));
            callback.onFinish!(totalUploadChunks, totalUploadSize, totalCost);
            return;
        }

        // check old data
        const clearState = await retry(() => this.#clearOldFile(fileContract, hexName, chunkLength, oldChunkCount), this.retries);
        if (!clearState) {
            callback.onFail!(new Error(`FlatDirectory: Failed to truncate old data!`));
            callback.onFinish!(totalUploadChunks, totalUploadSize, totalCost);
            return;
        }

        // Get old chunk hashes, If the chunk hashes is not passed, it is obtained here
        if (!chunkHashes) {
            const hashes = await this.#fetchHashes([{ key, chunkCount: oldChunkCount }]);
            chunkHashes = hashes[key];
        }

        for (let i = 0; i < chunkLength; i++) {
            const chunk = await getContentChunk(content, i * chunkDataSize, (i + 1) * chunkDataSize);

            // not change
            if (i < chunkHashes.length && ethers.keccak256(chunk) === chunkHashes[i]) {
                callback.onProgress!(i, chunkLength, false);
                continue;
            }

            // upload
            const txResponse = await retry(() => this.#uploadCallData(fileContract, key, hexName, i,
                chunk, gasIncPct, isConfirmedNonce, callback as UploadCallback), this.retries);
            const uploadResult = await retry(() => this._blobUploader.getTransactionResult(txResponse.hash), this.retries);

            // count tx costs, regardless of success or failure.
            totalCost += uploadResult.txCost.normalGasCost; // no blob/storage

            // fail
            if (!uploadResult.success) {
                callback.onFail!(new Error("FlatDirectory: Sending transaction failed."));
                break;
            }
            // success
            callback.onProgress!(i, chunkLength, true);
            totalUploadChunks++;
            totalUploadSize += chunk.length;
        }

        callback.onFinish!(totalUploadChunks, totalUploadSize, totalCost);
    }

    async #getEstimateBlobInfo(contract: any, hexName: string): Promise<UploadDetails> {
        const [result, maxFeePerBlobGas, gasFeeData]: [UploadDetails, bigint, ethers.FeeData] = await Promise.all([
            getUploadInfo(contract, hexName, this.retries),
            retry(() => this._blobUploader.getBlobGasPrice(), this.retries),
            retry(() => this._blobUploader.getGasPrice(), this.retries),
        ]);
        return {
            ...result,
            maxFeePerBlobGas,
            gasFeeData
        }
    }

    async #getEstimateCallDataInfo(contract: any, hexName: string): Promise<UploadDetails> {
        const [result, gasFeeData]: [UploadDetails, ethers.FeeData] = await Promise.all([
            getUploadInfo(contract, hexName, this.retries),
            retry(() => this._blobUploader.getGasPrice(), this.retries),
        ]);
        return {
            ...result,
            gasFeeData
        }
    }

    async #getUploadInfo(contract: any, hexName: string): Promise<UploadDetails> {
        return await getUploadInfo(contract, hexName, this.retries);
    }

    async #clearOldFile(contract: any, key: string, chunkLength: number, oldChunkLength: number): Promise<boolean> {
        if (oldChunkLength > chunkLength) {
            // truncate
            try {
                const tx = await contract.truncate(stringToHex(key), chunkLength);
                this.#log(`Truncate transaction sent (Key: ${key}, New length: ${chunkLength}). Hash: ${tx.hash}`);
                const receipt = await tx.wait();
                return receipt?.status === 1;
            } catch (e) {
                this.#log(`Failed to truncate old data for file (Key: ${key}). ${(e as any).message || e}`, true);
                return false;
            }
        }
        return true;
    }

    async #uploadBlob(
        fileContract: ethers.Contract,
        key: string,
        hexName: string,
        blobArr: Uint8Array[],
        blobCommitmentArr: Uint8Array[],
        chunkIdArr: number[],
        chunkSizeArr: number[],
        cost: bigint,
        gasIncPct: number,
        isConfirmedNonce: boolean,
        callback: UploadCallback
    ): Promise<ethers.TransactionResponse> {
        // create tx
        const value = cost * BigInt(blobArr.length);
        const tx: ethers.TransactionRequest = await fileContract["writeChunksByBlobs"].populateTransaction(hexName, chunkIdArr, chunkSizeArr, {
            value: value,
        });
        // Increase % if user requests it
        if (gasIncPct > 0) {
            // Fetch the current gas price and increase it
            const feeData = await this._blobUploader.getGasPrice();
            tx.maxFeePerGas = feeData.maxFeePerGas! * BigInt(100 + gasIncPct) / BigInt(100);
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas! * BigInt(100 + gasIncPct) / BigInt(100);
            // blob gas
            const blobGas = await this._blobUploader.getBlobGasPrice();
            tx.maxFeePerBlobGas = blobGas * BigInt(100 + gasIncPct) / BigInt(100);
        }

        // send
        const txResponse = await this._blobUploader.sendTxLock(tx, isConfirmedNonce, blobArr, blobCommitmentArr);
        this.#printHashLog(key, chunkIdArr, txResponse.hash, callback);
        return txResponse;
    }

    async #uploadCallData(
        fileContract: any,
        key: string,
        hexName: string,
        chunkId: number,
        chunk: Uint8Array,
        gasIncPct: number,
        isConfirmedNonce: boolean,
        callback: UploadCallback
    ): Promise<ethers.TransactionResponse> {
        const hexData = ethers.hexlify(chunk);
        const tx = await fileContract["writeChunkByCalldata"].populateTransaction(hexName, chunkId, hexData);
        // Increase % if user requests it
        if (gasIncPct > 0) {
            // Fetch the current gas price and increase it
            const feeData = await this._blobUploader.getGasPrice();
            tx.maxFeePerGas = feeData.maxFeePerGas! * BigInt(100 + gasIncPct) / BigInt(100);
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas! * BigInt(100 + gasIncPct) / BigInt(100);
        }

        // send
        const txResponse = await this._blobUploader.sendTxLock(tx, isConfirmedNonce);
        this.#printHashLog(key, chunkId, txResponse.hash, callback);
        return txResponse;
    }

    #getBlobLength(content: ContentLike): number {
        let blobLength = -1;
        if (isFile(content)) {
            blobLength = Math.ceil(content.size / OP_BLOB_DATA_SIZE);
        } else if (isBuffer(content)) {
            blobLength = Math.ceil(content.length / OP_BLOB_DATA_SIZE);
        }
        return blobLength;
    }

    async #getBlobInfo(content: ContentLike, index: number): Promise<{ blobArr: Uint8Array[]; chunkIdArr: number[]; chunkSizeArr: number[] }> {
        const data = await getContentChunk(content, index * OP_BLOB_DATA_SIZE, (index + MAX_BLOB_COUNT) * OP_BLOB_DATA_SIZE);
        const blobArr = encodeOpBlobs(data);

        const chunkIdArr: number[] = [];
        const chunkSizeArr: number[] = [];
        for (let j = 0; j < blobArr.length; j++) {
            chunkIdArr.push(index + j);
            if (j === blobArr.length - 1) {
                chunkSizeArr.push(data.length - OP_BLOB_DATA_SIZE * j);
            } else {
                chunkSizeArr.push(OP_BLOB_DATA_SIZE);
            }
        }
        return { blobArr, chunkIdArr, chunkSizeArr }
    }

    #getChunkLength(content: ContentLike): { chunkDataSize: number; chunkLength: number } {
        const maxChunkSize = 24 * 1024 - 326;
        const getChunkInfo = (size: number) => ({
            chunkDataSize: size > maxChunkSize ? maxChunkSize : size,
            chunkLength: size > maxChunkSize ? Math.ceil(size / maxChunkSize) : 1
        });

        if (isFile(content)) {
            return getChunkInfo(content.size);
        } else if (isBuffer(content)) {
            return getChunkInfo(content.length);
        }
        return { chunkDataSize: -1, chunkLength: 1 };
    }

    #printHashLog(key: string, chunkIds: number[] | number, hash: string, callback: UploadCallback) {
        const ids = Array.isArray(chunkIds) ? chunkIds.join(",") : chunkIds;
        const primaryMessage = `Transaction hash: ${hash} for chunk(s) ${ids}.`;
        const fullMessage = `${primaryMessage} (Key: ${key})`;
        this.#log(fullMessage);

        if (callback?.onTransactionSent) {
            callback.onTransactionSent(hash, chunkIds);
        }
    }

    #log(message: string, isError: boolean = false) {
        if (!this.logEnabled) return;
        const prefix = "FlatDirectory: ";
        if (isError) {
            console.error(`${prefix}${message}`);
        } else {
            console.log(`${prefix}${message}`);
        }
    }

    // -------------------- getter --------------------
    private get _contractAddr(): string {
        if (!this.contractAddr) throw new Error("FlatDirectory: Not deployed!");
        return this.contractAddr;
    }

    private get _ethStorageRpc(): string {
        if (!this.ethStorageRpc) throw new Error("FlatDirectory: 'ethStorageRpc' required.");
        return this.ethStorageRpc;
    }

    private get _rpc(): string {
        if (!this.rpc) throw new Error("FlatDirectory: 'rpc' required.");
        return this.rpc;
    }

    private get _wallet(): ethers.Wallet {
        if (!this.wallet) throw new Error("FlatDirectory: Private key required.");
        return this.wallet;
    }

    private get _blobUploader(): BlobUploader {
        if (!this.blobUploader) throw new Error("FlatDirectory: _blobUploader not initialized.");
        return this.blobUploader;
    }
}
