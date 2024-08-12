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
