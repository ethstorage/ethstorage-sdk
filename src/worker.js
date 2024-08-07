// worker.js
import workerpool from 'workerpool';
import {ethers} from "ethers";
import {initializeKzg} from './utils/wasm';

function computeVersionedHash(commitment, blobCommitmentVersion) {
    const computedVersionedHash = new Uint8Array(32);
    computedVersionedHash.set([blobCommitmentVersion], 0);
    const hash = ethers.getBytes(ethers.sha256(commitment));
    computedVersionedHash.set(hash.subarray(1), 1);
    return computedVersionedHash;
}

function commitmentsToVersionedHashes(commitment) {
    return computeVersionedHash(commitment, 0x01);
}

async function getBlobHash(blob) {
    const kzg = await initializeKzg();
    const commit = kzg.blobToKzgCommitment(blob);
    const localHash = commitmentsToVersionedHashes(commit);
    const hash = new Uint8Array(32);
    hash.set(localHash.subarray(0, 32 - 8));
    return ethers.hexlify(hash);
}

workerpool.worker({
    getBlobHash: getBlobHash
});
