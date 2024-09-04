import { ethers } from "ethers";
import { FlatDirectoryAbi } from "../param";
import {retry, stringToHex} from "./util";

export function createFlatDirectoryContract(address, runner) {
    return new ethers.Contract(address, FlatDirectoryAbi, runner);
}

export async function upfrontPayment(contract, retries) {
    return await retry(() => contract.upfrontPayment(), retries);
}

export async function countChunks(contract, hexName, retries) {
    const count = await retry(() => contract.countChunks(hexName), retries);
    // Bigint to number
    return Number(count);
}

export async function getStorageMode(contract, hexName, retries) {
    const mode = await retry(() => contract.getStorageMode(hexName), retries);
    // Bigint to number
    return Number(mode);
}

export async function getUploadInfo(contract, hexName, retries) {
    const result = await retry(() => contract.getUploadInfo(hexName), retries);
    return {
        mode: Number(result[0]),
        chunkSize: Number(result[1]),
        cost: result[2]
    }
}


export async function getChunkHash(contract, name, chunkId, retries) {
    const hash = await retry(() => contract.getChunkHash(stringToHex(name), chunkId), retries);
    return { name: name, chunkId: chunkId, hash: hash };
}

export async function getChunkHashes(contract, batch, retries) {
    const fileChunks = batch.map(file => [
        stringToHex(file.name),
        file.chunkIds
    ]);

    const hashes = await retry(() => contract.getBatchChunkHashes(fileChunks), retries);
    const results = [];
    let index = 0;
    for (let file of batch) {
        for (let j = 0; j < file.chunkIds.length; j++) {
            results.push({ name: file.name, chunkId: file.chunkIds[j], hash: hashes[index] });
            index++;
        }
    }
    return results;
}
