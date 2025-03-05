import {KZG} from 'micro-eth-signer/kzg';
import {trustedSetup} from './trustedSetup';
import {ethers} from 'ethers';

export class KZGWrapper {
    private kzg: KZG;

    constructor() {
        this.kzg = new KZG(trustedSetup);
    }

    private uint8ArrayToHexString(data: Uint8Array): string {
        return ethers.hexlify(data);
    }

    private ensureHexString(commitment: Uint8Array | string): string {
        if (typeof commitment === 'string') {
            return commitment;
        }
        return ethers.hexlify(commitment);
    }

    blobToKzgCommitment(blob: Uint8Array): Uint8Array {
        const blobHex = this.uint8ArrayToHexString(blob);
        const commitment = this.kzg.blobToKzgCommitment(blobHex);
        return ethers.getBytes(commitment);
    }

    computeBlobKzgProof(blob: Uint8Array, commitment: Uint8Array | string): Uint8Array {
        const blobHex = this.uint8ArrayToHexString(blob);
        const commitmentHex = this.ensureHexString(commitment);
        const proof = this.kzg.computeBlobProof(blobHex, commitmentHex);
        return ethers.getBytes(proof);
    }

    verifyBlobProof(blob: Uint8Array, commitment: Uint8Array | string): boolean {
        const blobHex = this.uint8ArrayToHexString(blob);
        const commitmentHex = this.ensureHexString(commitment);
        const proof = this.kzg.computeBlobProof(blobHex, commitmentHex);
        return this.kzg.verifyBlobProof(blobHex, commitmentHex, proof);
    }
}
