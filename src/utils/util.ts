import {ethers} from "ethers";

export const stringToHex = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));

export async function getChainId(rpc) {
    const provider = new ethers.JsonRpcProvider(rpc);
    const network = await provider.getNetwork();
    return Number(network.chainId);
}

export async function getContentChunk(content, start, end) {
    if (isBuffer(content)) {
        return content.slice(start, Math.min(end, content.length));
    } else {
        const slice = content.slice(start, Math.min(end, content.size));
        const data = await slice.arrayBuffer();
        return new Uint8Array(data);
    }
}

export function isBuffer(content) {
    return content instanceof Uint8Array;
}

export function isFile(content) {
    if (isNodejs()) {
        return content && typeof content === 'object' &&
            typeof content.isNodeJs === 'boolean' &&
            content.isNodeJs;
    } else {
        return content instanceof File;
    }
}

export function isNodejs() {
    return typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
}

function computeVersionedHash(commitment, blobCommitmentVersion) {
    const computedVersionedHash = new Uint8Array(32);
    computedVersionedHash.set([blobCommitmentVersion], 0);
    const hash = ethers.getBytes(ethers.sha256(commitment));
    computedVersionedHash.set(hash.subarray(1), 1);
    return computedVersionedHash;
}

export function commitmentsToVersionedHashes(commitment) {
    return computeVersionedHash(commitment, 0x01);
}

export function getHash(commit) {
    const localHash = commitmentsToVersionedHashes(commit);
    const hash = new Uint8Array(32);
    hash.set(localHash.subarray(0, 32 - 8));
    return ethers.hexlify(hash);
}

export async function retry(fn, retries, ...args) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn.apply(null, args);
        } catch (error) {
            if (i === retries - 1) {
                throw error;
            }
        }
    }
}

export function copy(des, desOff, src, srcOff) {
    const srcLength = src.length - srcOff;
    const desLength = des.length - desOff;
    const length = Math.min(srcLength, desLength);
    des.set(src.subarray(srcOff, srcOff + length), desOff);
    return length;
}
