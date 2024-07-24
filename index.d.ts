declare module 'ethstorage-sdk' {
    import { ethers } from 'ethers';
    import { NodeFile } from 'ethstorage-sdk/file';

    // Constants
    export const BLOB_DATA_SIZE: number;
    export const BLOB_SIZE: number;
    export const MAX_BLOB_COUNT: number;
    export const PaddingPer31Bytes: number;
    export const RawData: number;

    export const ETHSTORAGE_MAPPING: {
      [chainId: number]: string;
    };

    export const EthStorageAbi: string[];
    export const FlatDirectoryAbi: string[];
    export const FlatDirectoryBytecode: string;

    // Interfaces
    export interface SDKConfig {
      rpc: string;
      ethStorageRpc: string;
      privateKey: string;
      address?: string;
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
      putBlobs(number: number, data: Buffer | Uint8Array): Promise<boolean>;
    }

    export class FlatDirectory {
      static create(config: SDKConfig): Promise<FlatDirectory>;
      constructor(config: SDKConfig);
      init(rpc: string, address?: string): Promise<void>;
      deploy(): Promise<string | null>;
      setDefault(filename: string): Promise<boolean>;
      remove(key: string): Promise<boolean>;
      download(key: string, cb: Partial<DownloadCallback>): void;
      estimateCost(key: string, data: Buffer | Uint8Array): Promise<CostEstimate>;
      estimateFileCost(key: string, file: File | NodeFile): Promise<CostEstimate>;
      upload(key: string, data: Buffer | Uint8Array, cb?: Partial<UploadCallback>): Promise<void>;
      uploadFile(key: string, file: File | NodeFile, cb?: Partial<UploadCallback>): Promise<void>;
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
        sendTx(tx: ethers.TransactionRequest, blobs?: Uint8Array[]): Promise<ethers.TransactionResponse>;
        sendTxLock(tx: ethers.TransactionRequest, blobs?: Uint8Array[]): Promise<ethers.TransactionResponse>;
        getBlobHash(blob: Uint8Array): string;
      }

      export function stringToHex(s: string): string;
      export function getChainId(rpc: string): Promise<number>;
      export function encodeBlobs(data: Buffer): Uint8Array[];
      export function decodeBlob(blob: string | Uint8Array): Uint8Array;
      export function decodeBlobs(blobs: string | Uint8Array): Buffer;
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
