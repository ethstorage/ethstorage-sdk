import { Contract } from "ethers";
import { UploadDetails, ChunkCountResult, FileBatch, ChunkHashResult } from "../param";
import { stableRetry } from "./retry";
import { stringToHex } from "./util";

export async function getUploadInfo(contract: Contract, hexName: string): Promise<UploadDetails> {
    const result = await stableRetry(() => contract["getUploadInfo"](hexName));
    return {
        fileMode: Number(result[0]),
        oldChunkCount: Number(result[1]),
        cost: result[2] as bigint
    };
}

export async function getChunkCounts(contract: Contract, batch: string[]): Promise<ChunkCountResult[]> {
    const names = batch.map(key => stringToHex(key));
    const counts = await stableRetry(() => contract["getChunkCountsBatch"](names));
    const results: ChunkCountResult[] = [];
    let index = 0;
    for (const key of batch) {
        results.push({ key, chunkCount: Number(counts[index++]) });
    }
    return results;
}

export async function getChunkHashes(contract: Contract, batch: FileBatch[]): Promise<ChunkHashResult[]> {
    const fileChunks = batch.map(file => [
        stringToHex(file.name),
        file.chunkIds
    ]);

    const hashes = await stableRetry(() => contract["getChunkHashesBatch"](fileChunks));
    const results: ChunkHashResult[] = [];
    let index = 0;
    for (const file of batch) {
        for (let j = 0; j < file.chunkIds.length; j++) {
            results.push(<ChunkHashResult>{ name: file.name, chunkId: file.chunkIds[j], hash: hashes[index++] });
        }
    }
    return results;
}
