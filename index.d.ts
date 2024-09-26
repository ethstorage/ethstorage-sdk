declare module 'ethstorage-sdk' {
    import { ethers } from 'ethers';
    import { NodeFile } from 'ethstorage-sdk/file';

    // Constants
    export const BLOB_DATA_SIZE: number;
    export const OP_BLOB_DATA_SIZE: number;
    export const BLOB_SIZE: number;
    export const MAX_BLOB_COUNT: number;
    export const PaddingPer31Bytes: number;
    export const RawData: number;
    export const BLOB_COUNT_LIMIT: number;
    export const UPLOAD_TYPE_CALLDATA: number;
    export const UPLOAD_TYPE_BLOB: number;
    export const MAX_CHUNKS: number;

    export const ETHSTORAGE_MAPPING: {
      [chainId: number]: string;
    };

    export const EthStorageAbi: string[];
    export const FlatDirectoryAbi: string[];
    export const FlatDirectoryBytecode: string;

    // Types
    export type BufferLike = Buffer | Uint8Array;
    export type FileLike = File | NodeFile;
    export type ContentLike = BufferLike | FileLike;
    export type AsyncFunction<T> = (...args: any[]) => Promise<T>;

    // Interfaces
    export interface SDKConfig {
      rpc: string;
      ethStorageRpc?: string;
      privateKey: string;
      address?: string;
    }

    export interface EstimateGasRequest {
        key: string,
        content: ContentLike,
        type: number,
        gasIncPct?: number,
        chunkHashes?: Uint8Array[],
    }

    export interface UploadRequest extends EstimateGasRequest {
        callback: Partial<UploadCallback>,
    }

    export interface CostEstimate {
      storageCost: bigint;
      gasCost: bigint;
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

    // Classes
    export class EthStorage {
      static create(config: SDKConfig): Promise<EthStorage>;
      constructor(config: SDKConfig);
      init(rpc: string, address?: string): Promise<void>;
      estimateCost(key: string, data: Buffer | Uint8Array): Promise<CostEstimate>;
      write(key: string, data: Buffer | Uint8Array): Promise<boolean>;
      read(key: string): Promise<Uint8Array>;
      writeBlobs(keys: string[], dataBlobs: Buffer[] | Uint8Array[]): Promise<boolean>;
    }

    export class FlatDirectory {
      static create(config: SDKConfig): Promise<FlatDirectory>;
      isSupportBlob(): boolean;
      deploy(): Promise<string | null>;
      setDefault(filename: string): Promise<boolean>;
      remove(key: string): Promise<boolean>;
      download(key: string, cb: Partial<DownloadCallback>): void;
      fetchHashes(keys: string[], concurrencyLimit?:number):Promise<any>;
      estimateCost(request: EstimateGasRequest): Promise<CostEstimate>;
      upload(request: UploadRequest): Promise<void>;
    }

    // Utils
    export namespace utils {
      export class BlobUploader {
        static create(rpc: string, pk: string): Promise<BlobUploader>;
        constructor(rpc: string, pk: string);
        init(): Promise<void>;
        getNonce(): Promise<number>;
        getBlobGasPrice(): Promise<bigint>;
        getGasPrice(): Promise<ethers.FeeData>;
        estimateGas(params: any): Promise<bigint | null>;
        sendTx(tx: ethers.TransactionRequest, blobs?: Uint8Array[], commitments?: Uint8Array[]): Promise<ethers.TransactionResponse>;
        sendTxLock(tx: ethers.TransactionRequest, blobs?: Uint8Array[], commitments?: Uint8Array[]): Promise<ethers.TransactionResponse>;
        getCommitment(blob: Uint8Array): Uint8Array;
        getBlobHash(blob: Uint8Array): string;
      }

      export function encodeOpBlobs(data: Uint8Array): Uint8Array[];
      export function encodeOpBlob(blob: Uint8Array): Uint8Array;

      export function stringToHex(s: string): string;
      export function getChainId(rpc: string): Promise<number>;
      export function getContentChunk(content: ContentLike, start: number, end: number): Uint8Array;
      export function isBuffer(content: BufferLike): boolean;
      export function isFile(content: FileLike): boolean;
      export function isNodejs(): boolean;
      export function commitmentsToVersionedHashes(commitment: Uint8Array): string;
      export function getHash(commitment: Uint8Array): string;
      export function retry<T>(fn: AsyncFunction<T>, retries: number, isThrow?: boolean, ...args: any[]): Promise<T>;
    }

    // Default export
    const ethstorage: {
      BLOB_DATA_SIZE: number;
      BLOB_SIZE: number;
      ETHSTORAGE_MAPPING: typeof ETHSTORAGE_MAPPING;
      EthStorage: typeof EthStorage;
      EthStorageAbi: string[];
      FlatDirectory: typeof FlatDirectory;
      FlatDirectoryAbi: string[];
      FlatDirectoryBytecode: string;
      MAX_BLOB_COUNT: number;
      PaddingPer31Bytes: number;
      RawData: number;
      utils: typeof utils;
    };

    export default ethstorage;
}

declare module 'ethstorage-sdk/file' {
    // Classes
    export class NodeFile {
        constructor(filePath: string, start?: number, end?: number, type?: string);
        slice(start: number, end: number): NodeFile;
        arrayBuffer(): Promise<Buffer>;
        text(): Promise<string>;
        // stream(): ReadStream;
    }

    const nodefile: {
        NodeFile: typeof NodeFile;
    };

    export default nodefile;
}
