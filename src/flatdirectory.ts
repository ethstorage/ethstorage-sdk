import { ethers } from "ethers";
import {
    SDKConfig, EstimateGasRequest, UploadRequest, CostEstimate,
    DownloadCallback, UploadType, ContentLike, FileBatch,
    ChunkCountResult, ChunkHashResult, UploadDetails,
    FlatDirectoryAbi, FlatDirectoryBytecode, ETHSTORAGE_MAPPING,
    BLOB_SIZE, OP_BLOB_DATA_SIZE,
    MAX_BLOB_COUNT, MAX_RETRIES, MAX_CHUNKS,
    FLAT_DIRECTORY_CONTRACT_VERSION_1_0_0
} from './param';
import {
    BlobUploader,
    encodeOpBlobs,
    getChainId, getHash,
    isBuffer, isFile,
    stringToHex,
    retry, getContentChunk,
    getUploadInfo, getChunkCounts,
    getChunkHashes,
} from "./utils";

const defaultCallback: DownloadCallback = {
    onProgress: () => { },
    onFail: () => { },
    onFinish: () => { }
};

export class FlatDirectory {
    private ethStorageRpc?: string;
    private contractAddr?: string;

    private chainId!: number;
    private wallet!: ethers.Wallet;
    private blobUploader!: BlobUploader;

    private retries: number = MAX_RETRIES;
    public isSupportBlob: boolean = false;

    static async create(config: SDKConfig) {
        const flatDirectory = new FlatDirectory();
        if (config.privateKey) {
            await flatDirectory.init(config);
        } else {
            await flatDirectory.initWithoutPrivateKey(config);
        }
        return flatDirectory;
    }

    async init(config: SDKConfig) {
        const {rpc, ethStorageRpc, privateKey, address} = config;
        this.ethStorageRpc = ethStorageRpc;
        this.contractAddr = address;

        const provider = new ethers.JsonRpcProvider(rpc);
        this.wallet = new ethers.Wallet(privateKey, provider);
        this.blobUploader = new BlobUploader(rpc, privateKey);
        this.chainId = await getChainId(rpc);
        if (!address) return;

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
        if (contractVersion !== FLAT_DIRECTORY_CONTRACT_VERSION_1_0_0) {
            throw new Error("FlatDirectory: The current SDK does not support this contract. Please switch to version 2.0.0.");
        }
        this.isSupportBlob = supportBlob as boolean;
    }

    async initWithoutPrivateKey(config: SDKConfig): Promise<void> {
        const { ethStorageRpc, address } = config;
        if(!ethStorageRpc || !address) {
            throw new Error("FlatDirectory: Invalid contract address and ethstorage rpc");
        }

        this.ethStorageRpc = ethStorageRpc;
        this.contractAddr = address;
        const provider = new ethers.JsonRpcProvider(ethStorageRpc);
        const fileContract = new ethers.Contract(address, FlatDirectoryAbi, provider);
        const contractVersion = await retry(() => fileContract["version"](), this.retries).catch((e) => {
            if (e?.code === 'BAD_DATA') return "0";
            throw e;
        });
        if (contractVersion !== FLAT_DIRECTORY_CONTRACT_VERSION_1_0_0) {
            throw new Error("FlatDirectory: The current SDK does not support this contract. Please switch to version 2.0.0.");
        }
    }

    async deploy(): Promise<string | null> {
        if (!this.wallet) {
            console.error(`FlatDirectory: Private key is required for this operation.`);
            return null;
        }

        this.isSupportBlob = ETHSTORAGE_MAPPING[this.chainId] != null;

        const ethStorage = ETHSTORAGE_MAPPING[this.chainId] || '0x0000000000000000000000000000000000000000';
        const factory = new ethers.ContractFactory(FlatDirectoryAbi, FlatDirectoryBytecode, this.wallet);
        try {
            // @ts-ignore
            const contract = await factory.deploy(0, OP_BLOB_DATA_SIZE, ethStorage, {gasLimit: 3800000});
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
        this.checkPrivateKeyRequired();
        if (!this.contractAddr) {
            throw new Error(`FlatDirectory: FlatDirectory not deployed!`);
        }

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
        this.checkPrivateKeyRequired();
        if (!this.contractAddr) {
            throw new Error(`FlatDirectory: FlatDirectory not deployed!`);
        }

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
        if (!this.contractAddr) {
            throw new Error(`FlatDirectory: FlatDirectory not deployed!`);
        }
        if (!this.ethStorageRpc) {
            throw new Error(`FlatDirectory: Reading content requires providing 'ethStorageRpc'.`);
        }

        const hexName = stringToHex(key);
        const provider = new ethers.JsonRpcProvider(this.ethStorageRpc);
        const contract = new ethers.Contract(this.contractAddr, FlatDirectoryAbi, provider);
        try {
            const result = await getChunkCounts(contract, [key], this.retries);
            const blobCount = result[0].chunkCount;
            for (let i = 0; i < blobCount; i++) {
                const result = await contract["readChunk"](hexName, i);
                cb.onProgress(i, blobCount, ethers.getBytes(result[0]));
            }
            cb.onFinish();
        } catch (err) {
            cb.onFail(err as Error);
        }
    }

    async fetchHashes(keys: string[]): Promise<Record<string, string[]>> {
        this.checkPrivateKeyRequired();
        if (!this.contractAddr) {
            throw new Error(`FlatDirectory: FlatDirectory not deployed!`);
        }
        if (!keys || !Array.isArray(keys)) {
            throw new Error('Invalid keys.');
        }

        // get file chunks
        const contract = new ethers.Contract(this.contractAddr, FlatDirectoryAbi, this.wallet);
        const fileInfos = await getChunkCounts(contract, keys, this.retries);
        return this.#fetchHashes(fileInfos);
    }

    async estimateCost(request: EstimateGasRequest): Promise<CostEstimate> {
        this.checkPrivateKeyRequired();
        if (!this.contractAddr) {
            throw new Error(`FlatDirectory: FlatDirectory not deployed!`);
        }

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



    // private method
    private checkPrivateKeyRequired() {
        if (!this.wallet) {
            throw new Error("FlatDirectory: Private key is required for this operation.");
        }
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
            const contract = new ethers.Contract(this.contractAddr!, FlatDirectoryAbi, this.wallet);
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
        const fileContract = new ethers.Contract(this.contractAddr!, FlatDirectoryAbi, this.wallet);
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
            // check change
            if (i + blobArr.length <= chunkHashes.length) {
                blobHashArr = this.#getBlobHashes(blobArr);
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
                blobHashArr = blobHashArr || this.#getBlobHashes(blobArr);
                gasLimit = await retry(() => fileContract["writeChunks"].estimateGas(hexName, chunkIdArr, chunkSizeArr, {
                    value: value,
                    blobVersionedHashes: blobHashArr
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
        const fileContract = new ethers.Contract(this.contractAddr!, FlatDirectoryAbi, this.wallet) as any;
        const { oldChunkCount, fileMode, gasFeeData } = await this.#getEstimateCallDataInfo(fileContract, hexName);
        if (fileMode !== UploadType.Calldata && fileMode !== UploadType.Undefined) {
            throw new Error(`FlatDirectory: This file does not support calldata upload!`);
        }

        // Get old chunk hashes, If the chunk hashes is not passed, it is obtained here
        if (!chunkHashes) {
            const hashes = await this.#fetchHashes([{ key, chunkCount: oldChunkCount }]);
            chunkHashes = hashes[key];
        }

        let totalStorageCost = 0n;
        let totalGasCost = 0n;
        let gasLimit = 0n;
        for (let i = 0; i < chunkLength; i++) {
            const chunk = await getContentChunk(content, i * chunkDataSize, (i + 1) * chunkDataSize);

            // check is change
            if (i < chunkHashes.length && ethers.keccak256(chunk) === chunkHashes[i]) {
                continue;
            }

            // get cost, Galileo need stake
            const cost = chunk.length > 24 * 1024 - 326 ? ethers.parseEther(Math.floor((chunk.length + 326) / 1024 / 24).toString()) : 0n;
            if (i === chunkLength - 1 || gasLimit === 0n) {
                const hexData = ethers.hexlify(chunk);
                gasLimit = await retry(() => fileContract["writeChunk"].estimateGas(hexName, 0, hexData, { value: cost }), this.retries);
            }
            totalStorageCost += cost;
            totalGasCost += (gasFeeData!.maxFeePerGas! + gasFeeData!.maxPriorityFeePerGas!) * gasLimit;
        }
        totalGasCost += (totalGasCost * BigInt(gasIncPct)) / 100n;

        return {
            storageCost: totalStorageCost,
            gasCost: totalGasCost
        }
    }

    async #uploadByBlob(request: UploadRequest): Promise<void> {
        let totalUploadChunks = 0, totalUploadSize = 0;
        let totalStorageCost = 0n;

        let { key, content, callback, chunkHashes, gasIncPct = 0 } = request;
        if (!this.isSupportBlob) {
            callback.onFail?.(new Error(`FlatDirectory: The contract does not support blob upload!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const blobLength = this.#getBlobLength(content);
        if (blobLength === -1) {
            callback.onFail?.(new Error(`FlatDirectory: Invalid upload content!`));
            callback.onFinish?.(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.contractAddr!, FlatDirectoryAbi, this.wallet);
        const { cost, oldChunkCount, fileMode } = await this.#getUploadInfo(fileContract, hexName);
        if (fileMode !== UploadType.Blob && fileMode !== UploadType.Undefined) {
            callback.onFail!(new Error(`FlatDirectory: This file does not support blob upload!`));
            callback.onFinish!(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const clearState = await retry(() => this.#clearOldFile(fileContract, hexName, blobLength, oldChunkCount), this.retries);
        if (!clearState) {
            callback.onFail!(new Error(`FlatDirectory: Failed to truncate old data!`));
            callback.onFinish!(totalUploadChunks, totalUploadSize, totalStorageCost);
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
            const blobCommitmentArr = this.#getBlobCommitments(blobArr);

            // check change
            if (i + blobArr.length <= chunkHashes.length) {
                const localHashArr = this.#getHashes(blobCommitmentArr);
                const cloudHashArr = chunkHashes.slice(i, i + localHashArr.length);
                if (JSON.stringify(localHashArr) === JSON.stringify(cloudHashArr)) {
                    callback.onProgress!(chunkIdArr[chunkIdArr.length - 1], blobLength, false);
                    continue;
                }
            }

            // upload
            const status = await retry(() => this.#uploadBlob(fileContract, key, hexName, blobArr,
                blobCommitmentArr, chunkIdArr, chunkSizeArr, cost, gasIncPct), this.retries);
            if (!status) {
                callback.onFail!(new Error("FlatDirectory: Sending transaction failed."));
                break;
            }

            // success
            callback.onProgress!(chunkIdArr[chunkIdArr.length - 1], blobLength, true);
            totalStorageCost += cost * BigInt(blobArr.length);
            totalUploadChunks += blobArr.length;
            totalUploadSize += chunkSizeArr.reduce((acc: number, size: number) => acc + size, 0);
        }

        callback.onFinish!(totalUploadChunks, totalUploadSize, totalStorageCost);
    }

    async #uploadByCallData(request: UploadRequest): Promise<void> {
        let totalUploadChunks = 0, totalUploadSize = 0;
        let totalStorageCost = 0n;

        let { key, content, callback, chunkHashes, gasIncPct = 0 } = request;

        const { chunkDataSize, chunkLength } = this.#getChunkLength(content);
        if (chunkDataSize === -1) {
            callback.onFail!(new Error(`FlatDirectory: Invalid upload content!`));
            callback.onFinish!(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.contractAddr!, FlatDirectoryAbi, this.wallet);
        const { oldChunkCount, fileMode } = await this.#getUploadInfo(fileContract, hexName);
        if (fileMode !== UploadType.Calldata && fileMode !== UploadType.Undefined) {
            callback.onFail!(new Error(`FlatDirectory: This file does not support calldata upload!`));
            callback.onFinish!(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // check old data
        const clearState = await retry(() => this.#clearOldFile(fileContract, hexName, chunkLength, oldChunkCount), this.retries);
        if (!clearState) {
            callback.onFail!(new Error(`FlatDirectory: Failed to truncate old data!`));
            callback.onFinish!(totalUploadChunks, totalUploadSize, totalStorageCost);
            return;
        }

        // Get old chunk hashes, If the chunk hashes is not passed, it is obtained here
        if (!chunkHashes) {
            const hashes = await this.#fetchHashes([{ key, chunkCount: oldChunkCount }]);
            chunkHashes = hashes[key];
        }

        for (let i = 0; i < chunkLength; i++) {
            const chunk = await getContentChunk(content, i * chunkDataSize, (i + 1) * chunkDataSize);

            // check is change
            if (i < chunkHashes.length && ethers.keccak256(chunk) === chunkHashes[i]) {
                callback.onProgress!(i, chunkLength, false);
                continue;
            }

            // upload
            const status = await retry(() => this.#uploadCallData(fileContract, key, hexName, i, chunk, gasIncPct), this.retries);
            if (!status) {
                callback.onFail!(new Error("FlatDirectory: Sending transaction failed."));
                break;
            }

            // success
            const cost = chunk.length > 24 * 1024 - 326 ? BigInt(Math.floor((chunk.length + 326) / 1024 / 24)) : 0n;
            callback.onProgress!(i, chunkLength, true);
            totalStorageCost += cost;
            totalUploadChunks++;
            totalUploadSize += chunk.length;
        }

        callback.onFinish!(totalUploadChunks, totalUploadSize, totalStorageCost);
    }

    async #getEstimateBlobInfo(contract: any, hexName: string): Promise<UploadDetails> {
        const [result, maxFeePerBlobGas, gasFeeData]: [UploadDetails, bigint, ethers.FeeData] = await Promise.all([
            getUploadInfo(contract, hexName, this.retries),
            retry(() => this.blobUploader.getBlobGasPrice(), this.retries),
            retry(() => this.blobUploader.getGasPrice(), this.retries),
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
            retry(() => this.blobUploader.getGasPrice(), this.retries),
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
                console.log(`FlatDirectory: Truncate tx hash is ${tx.hash}`);
                const receipt = await tx.wait();
                return receipt?.status === 1;
            } catch (e) {
                console.error(`FlatDirectory: Failed to truncate file: ${key}`, (e as { message?: string }).message || e);
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
        gasIncPct: number
    ): Promise<boolean> {
        // create tx
        const value = cost * BigInt(blobArr.length);
        const tx: ethers.TransactionRequest = await fileContract["writeChunks"].populateTransaction(hexName, chunkIdArr, chunkSizeArr, {
            value: value,
        });
        // Increase % if user requests it
        if (gasIncPct > 0) {
            // Fetch the current gas price and increase it
            const feeData = await this.blobUploader.getGasPrice();
            tx.maxFeePerGas = feeData.maxFeePerGas! * BigInt(100 + gasIncPct) / BigInt(100);
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas! * BigInt(100 + gasIncPct) / BigInt(100);
            // blob gas
            const blobGas = await this.blobUploader.getBlobGasPrice();
            tx.maxFeePerBlobGas = blobGas * BigInt(100 + gasIncPct) / BigInt(100);
        }

        // send
        const txResponse = await this.blobUploader.sendTxLock(tx, blobArr, blobCommitmentArr);
        this.#printHashLog(key, chunkIdArr, txResponse.hash);
        const txReceipt = await txResponse.wait();
        return txReceipt?.status === 1;
    }

    async #uploadCallData(
        fileContract: any,
        key: string,
        hexName: string,
        chunkId: number,
        chunk: Uint8Array,
        gasIncPct: number
    ): Promise<boolean | undefined> {
        const hexData = ethers.hexlify(chunk);
        const cost = chunk.length > 24 * 1024 - 326 ? BigInt(Math.floor((chunk.length + 326) / 1024 / 24)) : 0n;
        const tx = await fileContract["writeChunk"].populateTransaction(hexName, chunkId, hexData, {
            value: ethers.parseEther(cost.toString())
        });
        // Increase % if user requests it
        if (gasIncPct > 0) {
            // Fetch the current gas price and increase it
            const feeData = await this.blobUploader.getGasPrice();
            tx.maxFeePerGas = feeData.maxFeePerGas! * BigInt(100 + gasIncPct) / BigInt(100);
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas! * BigInt(100 + gasIncPct) / BigInt(100);
        }

        // send
        const txResponse = await this.blobUploader.sendTxLock(tx);
        this.#printHashLog(key, chunkId, txResponse.hash);
        const txReceipt = await txResponse.wait();
        return txReceipt?.status === 1;
    }

    #getBlobCommitments(blobArr: Uint8Array[]): Uint8Array[] {
        return blobArr.map(blob => this.blobUploader.getCommitment(blob));
    }

    #getHashes(blobCommitmentArr: Uint8Array[]): string[] {
        return blobCommitmentArr.map(comment => getHash(comment));
    }

    #getBlobHashes(blobArr: Uint8Array[]): string[] {
        const commitments = this.#getBlobCommitments(blobArr);
        return this.#getHashes(commitments);
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

    #printHashLog(key: string, chunkIds: number[] | number, hash: string) {
        if (Array.isArray(chunkIds) && chunkIds.length > 1) {
            console.log(`FlatDirectory: The transaction hash for chunks ${chunkIds} is ${hash}`, "", key);
        } else {
            console.log(`FlatDirectory: The transaction hash for chunk ${chunkIds} is ${hash}`, "", key);
        }
    }
}
