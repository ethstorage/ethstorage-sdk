import workerpool from 'workerpool';
import {loadKZG} from 'kzg-wasm';
import {getHash} from "../utils";

let kzgInstance = null;

async function initializeKzg() {
    if (!kzgInstance) {
        kzgInstance = await loadKZG();
    }
    return kzgInstance;
}

async function getBlobHash(blob) {
    const kzg = await initializeKzg();
    return getHash(kzg, blob);
}

workerpool.worker({
    getBlobHash: getBlobHash,
});
