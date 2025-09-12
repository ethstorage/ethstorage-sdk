import { ethers } from "ethers";
import { UploadType } from "./constant";


// NodeFile Type
export interface NodeFile {
    isNodeJs: boolean;
    size: number;
    start: number;
    end: number;
    slice(start: number, end: number): NodeFile;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
}


// Type
export type BufferLike = Uint8Array;
export type FileLike = File | NodeFile;
export type ContentLike = BufferLike | FileLike;


// Interface
export interface SDKConfig {
    rpc?: string;
    privateKey?: string; //  only read?
    ethStorageRpc?: string;
    address?: string;
}

export interface UploadCallback {
    onProgress: (currentChunk: number, totalChunks: number, isChange: boolean) => void;
    onFail: (error: Error) => void;
    onFinish: (totalUploadChunks: number, totalUploadSize: number, totalCost: bigint) => void;
}

export interface DownloadCallback {
    onProgress: (currentChunk: number, totalChunks: number, chunkData: Uint8Array) => void;
    onFail: (error: Error) => void;
    onFinish: () => void;
}

export interface EstimateGasRequest {
    key: string,
    content: ContentLike,
    type: UploadType,
    gasIncPct?: number,
    chunkHashes?: string[],
}

export interface UploadRequest extends EstimateGasRequest {
    callback: Partial<UploadCallback>,
}

export interface CostEstimate {
    storageCost: bigint;
    gasCost: bigint;
}

export interface TxCost {
    normalGasCost: bigint;
    blobGasCost: bigint;
}

export interface UploadResult {
    txCost: TxCost;
    success: boolean;
}

export interface FileBatch {
    name: string;
    chunkIds: number[];
}

export interface UploadDetails {
    fileMode: number;
    oldChunkCount: number;
    cost: bigint;
    gasFeeData?: ethers.FeeData,
    maxFeePerBlobGas?: bigint,
}

export interface ChunkCountResult {
    key: string;
    chunkCount: number;
}

export interface ChunkHashResult {
    name: string;
    chunkId: number;
    hash: string;
}
