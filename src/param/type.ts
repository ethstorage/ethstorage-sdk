import { UploadType } from "./constant";
import { TrustedSetup } from "kzg-wasm";
import {ethers} from "ethers";

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

// KZG
export interface KZG {
    loadTrustedSetup: (trustedSetup?: TrustedSetup) => number;
    freeTrustedSetup: () => void;
    blobToKzgCommitment: (blob: Uint8Array) => Uint8Array;
    computeBlobKzgProof: (blob: Uint8Array, commitment: Uint8Array) => Uint8Array;
    verifyBlobKzgProofBatch: (blobs: Uint8Array[], commitments: Uint8Array[], proofs: Uint8Array[]) => boolean;
    verifyKzgProof: (commitment: Uint8Array, z: Uint8Array, y: Uint8Array, proof: Uint8Array) => boolean;
    verifyBlobKzgProof: (blob: Uint8Array, commitment: Uint8Array, proof: Uint8Array) => boolean
}


// Type
export type BufferLike = Uint8Array;
export type FileLike = File | NodeFile;
export type ContentLike = BufferLike | FileLike;

// Interface
export interface SDKConfig {
    rpc: string;
    privateKey: string;
    ethStorageRpc?: string;
    address?: string;
}

export interface UploadCallback {
    onProgress: (currentChunk: number, totalChunks: number, isChange: boolean) => void;
    onFail: (error: Error) => void;
    onFinish: (totalUploadChunks: number, totalUploadSize: number, totalStorageCost: bigint) => void;
}

export interface DownloadCallback {
    onProgress: (currentChunk: number, totalChunks: number, chunkData: Buffer) => void;
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


// fetch hash

export interface FileBatch {
    name: string;
    chunkIds: number[];
}

export interface UploadDetails {
    mode: number;
    chunkCount: number;
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