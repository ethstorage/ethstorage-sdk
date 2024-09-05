import {ethers} from "ethers";

export const stringToHex = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));

export async function getChainId(rpc) {
    const provider = new ethers.JsonRpcProvider(rpc);
    const network = await provider.getNetwork();
    return Number(network.chainId);
}

export async function getFileChunk(file, fileSize, start, end) {
    end = end > fileSize ? fileSize : end;
    const slice = file.slice(start, end);
    const data = await slice.arrayBuffer();
    return Buffer.from(data);
}

export function isBuffer(content) {
    return (content instanceof Uint8Array) || (content instanceof Buffer);
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

export function commitmentsToVersionedHashes(commitment) {
    const computedVersionedHash = new Uint8Array(32);
    computedVersionedHash.set([0x01], 0);
    const hash = ethers.getBytes(ethers.sha256(commitment));
    computedVersionedHash.set(hash.subarray(1), 1);
    return computedVersionedHash;
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

export async function limit(concurrencyLimit, asyncTasks) {
    const results = [];
    const executing = [];
    for (const task of asyncTasks) {
        const p = task().then(result => {
            results.push(result);
            return result;
        }).finally(() => executing.splice(executing.indexOf(p), 1));
        executing.push(p);

        if (executing.length >= concurrencyLimit) {
            await Promise.race(executing);
        }
    }
    await Promise.all(executing);
    return results;
}
