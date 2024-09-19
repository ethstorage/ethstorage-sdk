import { retry, stringToHex } from "./util";
import { Contract } from "ethers";
import { UploadDetails, ChunkCountResult, FileBatch, ChunkHashResult } from "../param";

export async function countChunks(contract: Contract, hexName: string, retries: number): Promise<number> {
    const count = await retry(() => contract["countChunks"](hexName), retries);
    // Bigint to number
    return Number(count);
}

export async function getUploadDetails(contract: Contract, hexName: string, retries: number): Promise<UploadDetails> {
    const result = await retry(() => contract["getUploadDetails"](hexName), retries);
    return {
        mode: Number(result[0]),
        chunkCount: Number(result[1]),
        cost: result[2] as bigint
    };
}

export async function getChunkCounts(contract: Contract, batch: string[], retries: number): Promise<ChunkCountResult[]> {
    const names = batch.map(key => stringToHex(key));
    const counts = await retry(() => contract["getChunkCountsBatch"](names), retries);
    const results: ChunkCountResult[] = [];
    let index = 0;
    for (const key of batch) {
        results.push({ key, chunkCount: Number(counts[index++]) });
    }
    return results;
}

export async function getChunkHashes(contract: Contract, batch: FileBatch[], retries: number): Promise<ChunkHashResult[]> {
    const fileChunks = batch.map(file => [
        stringToHex(file.name),
        file.chunkIds
    ]);

    const hashes = await retry(() => contract["getChunkHashesBatch"](fileChunks), retries);
    const results: ChunkHashResult[] = [];
    let index = 0;
    for (const file of batch) {
        for (let j = 0; j < file.chunkIds.length; j++) {
            results.push(<ChunkHashResult>{ name: file.name, chunkId: file.chunkIds[j], hash: hashes[index++] });
        }
    }
    return results;
}
