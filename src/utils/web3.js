import { retry, stringToHex } from "./util";

export async function getUploadInfo(contract, hexName, retries) {
    const result = await retry(() => contract.getUploadInfo(hexName), retries);
    return {
        fileMode: Number(result[0]),
        oldChunkCount: Number(result[1]),
        cost: result[2]
    }
}

export async function getChunkCounts(contract, batch, retries) {
    const names = batch.map(key => stringToHex(key));
    const counts = await retry(() => contract.getChunkCountsBatch(names), retries);
    const results = [];
    let index = 0;
    for (let key of batch) {
        results.push({key: key, chunkCount: Number(counts[index++])});
    }
    return results;
}

export async function getChunkHashes(contract, batch, retries) {
    const fileChunks = batch.map(file => [
        stringToHex(file.name),
        file.chunkIds
    ]);

    const hashes = await retry(() => contract.getChunkHashesBatch(fileChunks), retries);
    const results = [];
    let index = 0;
    for (let file of batch) {
        for (let j = 0; j < file.chunkIds.length; j++) {
            results.push({ name: file.name, chunkId: file.chunkIds[j], hash: hashes[index++] });
        }
    }
    return results;
}
