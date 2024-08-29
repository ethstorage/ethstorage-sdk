import { ethers } from "ethers";
import { ContentLike, BufferLike, FileLike } from "../param";

export const stringToHex = (s: string): string => ethers.hexlify(ethers.toUtf8Bytes(s));

export async function getChainId(rpc: string): Promise<number> {
    const provider = new ethers.JsonRpcProvider(rpc);
    const network = await provider.getNetwork();
    return Number(network.chainId);
}

export async function getFileChunk(file: FileLike, fileSize: number, start: number, end: number): Promise<Uint8Array> {
    end = Math.min(end, fileSize);
    const slice = file.slice(start, end);
    const data = await slice.arrayBuffer();
    return new Uint8Array(data);
}

export function getBufferChunk(data: BufferLike, dataLength: number, start: number, end: number): Uint8Array {
    end = Math.min(end, dataLength);
    return data.slice(start, end);
}

export function isBuffer(content: ContentLike): content is BufferLike {
    return content instanceof Uint8Array;
}

export function isFile(content: ContentLike): content is FileLike {
    if (isNodejs()) {
        return content && typeof content === 'object' &&
            typeof (content as any).isNodeJs === 'boolean' &&
            (content as any).isNodeJs;
    } else {
        return content instanceof File;
    }
}

export function isNodejs(): boolean {
    return typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
}

function computeVersionedHash(commitment: Uint8Array, blobCommitmentVersion: number): Uint8Array {
    const computedVersionedHash = new Uint8Array(32);
    computedVersionedHash.set([blobCommitmentVersion], 0);
    const hash = ethers.getBytes(ethers.sha256(commitment));
    computedVersionedHash.set(hash.subarray(1), 1);
    return computedVersionedHash;
}

export function commitmentsToVersionedHashes(commitment: Uint8Array): Uint8Array {
    return computeVersionedHash(commitment, 0x01);
}

export function getHash(commit: Uint8Array): string {
    const localHash = commitmentsToVersionedHashes(commit);
    const hash = new Uint8Array(32);
    hash.set(localHash.subarray(0, 32 - 8));
    return ethers.hexlify(hash);
}

export async function retry<T>(fn: (...args: any[]) => Promise<T>, retries: number, ...args: any[]): Promise<T> {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn(...args);
        } catch (error) {
            if (i === retries - 1) {
                throw error;
            }
        }
    }
    throw new Error('Function failed after maximum retries');
}

// Copy data from src to des with offsets
export function copy(des: Uint8Array, desOff: number, src: Uint8Array, srcOff: number): number {
    const srcLength = src.length - srcOff;
    const desLength = des.length - desOff;
    const length = Math.min(srcLength, desLength);
    des.set(src.subarray(srcOff, srcOff + length), desOff);
    return length;
}
