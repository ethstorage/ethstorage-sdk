// worker.js
import workerpool from 'workerpool';
import {getHash} from "../utils";
import {initializeKzg} from './wasm';

async function getBlobHash(blob) {
    const kzg = await initializeKzg();
    return getHash(kzg, blob);
}

workerpool.worker({
    getBlobHash: getBlobHash
});
