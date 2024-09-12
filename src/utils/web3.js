import {retry, stringToHex} from "./util";

export async function countChunks(contract, hexName, retries) {
    const count = await retry(() => contract.countChunks(hexName), retries);
    // Bigint to number
    return Number(count);
}

export async function getUploadInfo(contract, hexName, retries) {
    const result = await retry(() => contract.getUploadInfo(hexName), retries);
    return {
        mode: Number(result[0]),
        chunkSize: Number(result[1]),
        cost: result[2]
    }
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
