import {loadKZG} from 'kzg-wasm';

let kzgInstance = null;

export async function initializeKzg() {
    if (!kzgInstance) {
        kzgInstance = await loadKZG();
    }
    return kzgInstance;
}
