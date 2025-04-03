import { ethers } from "ethers";
import { ContentLike, BufferLike, FileLike } from "../param";

export const stringToHex = (s: string): string => ethers.hexlify(ethers.toUtf8Bytes(s));

export async function getChainId(rpc: string): Promise<number> {
    const provider = new ethers.JsonRpcProvider(rpc);
    const network = await provider.getNetwork();
    return Number(network.chainId);
}

export async function getContentChunk(content: ContentLike, start: number, end: number) {
    if (isBuffer(content)) {
        return content.slice(start, Math.min(end, content.length));
    } else {
        const slice = content.slice(start, Math.min(end, content.size));
        const data = await slice.arrayBuffer();
        return new Uint8Array(data);
    }
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

export function computeVersionedCommitmentHash(commitment: Uint8Array): Uint8Array {
    const computedVersionedHash = new Uint8Array(32);
    computedVersionedHash.set([0x01], 0);
    const hash = ethers.getBytes(ethers.sha256(commitment));
    computedVersionedHash.set(hash.subarray(1), 1);
    return computedVersionedHash;
}

export function truncateCommitmentHash(commitment: Uint8Array): string {
    const localHash = computeVersionedCommitmentHash(commitment);
    const hash = new Uint8Array(32);
    hash.set(localHash.subarray(0, 32 - 8));
    return ethers.hexlify(hash);
}

export function truncateCommitmentHashes(commitments: Uint8Array[]): string[] {
    return commitments.map(commitment => truncateCommitmentHash(commitment));
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

export function copy(des: Uint8Array, desOff: number, src: Uint8Array, srcOff: number): number {
    const srcLength = src.length - srcOff;
    const desLength = des.length - desOff;
    const length = Math.min(srcLength, desLength);
    des.set(src.subarray(srcOff, srcOff + length), desOff);
    return length;
}
