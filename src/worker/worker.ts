import workerpool from 'workerpool';
import { loadKZG } from 'kzg-wasm';
import { KZG } from "../param";

let kzgInstance: KZG | null = null;

async function initializeKzg() {
    if (!kzgInstance) {
        kzgInstance = await loadKZG();
    }
    return kzgInstance;
}

async function getCommitment(blob: Uint8Array) {
    const kzg = await initializeKzg();
    return kzg.blobToKzgCommitment(blob);
}

workerpool.worker({
    getCommitment: getCommitment,
});
