import workerpool from 'workerpool';
import {loadKZG} from 'kzg-wasm';

let kzgInstance = null;

async function initializeKzg() {
    if (!kzgInstance) {
        kzgInstance = await loadKZG();
    }
    return kzgInstance;
}

async function getCommitment(blob) {
    const kzg = await initializeKzg();
    return kzg.blobToKzgCommitment(blob);
}

workerpool.worker({
    getCommitment: getCommitment,
});
