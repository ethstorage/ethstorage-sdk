import { ethers } from "ethers";
import { loadKZG, TrustedSetup } from 'kzg-wasm';
import { Mutex } from 'async-mutex';
import { getHash, commitmentsToVersionedHashes } from "./util";

// blob gas price
const MIN_BLOB_GASPRICE: bigint = 1n;
const BLOB_GASPRICE_UPDATE_FRACTION: bigint = 3338477n;

function fakeExponential(factor: bigint, numerator: bigint, denominator: bigint): bigint {
    let i: bigint = 1n;
    let output: bigint = 0n;
    let numerator_accum: bigint = factor * denominator;
    while (numerator_accum > 0n) {
        output += numerator_accum;
        numerator_accum = (numerator_accum * numerator) / (denominator * i);
        i++;
    }
    return output / denominator;
}

interface KZG {
    loadTrustedSetup: (trustedSetup?: TrustedSetup) => number;
    freeTrustedSetup: () => void;
    blobToKzgCommitment: (blob: Uint8Array) => Uint8Array;
    computeBlobKzgProof: (blob: Uint8Array, commitment: Uint8Array) => Uint8Array;
    verifyBlobKzgProofBatch: (blobs: Uint8Array[], commitments: Uint8Array[], proofs: Uint8Array[]) => boolean;
    verifyKzgProof: (commitment: Uint8Array, z: Uint8Array, y: Uint8Array, proof: Uint8Array) => boolean;
    verifyBlobKzgProof: (blob: Uint8Array, commitment: Uint8Array, proof: Uint8Array) => boolean
}

export class BlobUploader {
    private kzg: KZG;

    private readonly provider: ethers.JsonRpcProvider;
    private readonly wallet: ethers.Wallet;
    private readonly mutex: Mutex;

    static async create(rpc: string, pk: string): Promise<BlobUploader> {
        const uploader = new BlobUploader(rpc, pk);
        await uploader.init();
        return uploader;
    }

    private constructor(rpc: string, pk: string) {
        this.provider = new ethers.JsonRpcProvider(rpc);
        this.wallet = new ethers.Wallet(pk, this.provider);
        this.mutex = new Mutex();
    }

    private async init(): Promise<any> {
        if (!this.kzg) {
            this.kzg = await loadKZG();
        }
        return this.kzg;
    }

    async getNonce(): Promise<number> {
        return await this.wallet.getNonce();
    }

    async getBlobGasPrice(): Promise<bigint> {
        const block = await this.provider.getBlock("latest");
        if (block?.excessBlobGas === null) {
            throw new Error("Block has no excessBlobGas");
        }
        const excessBlobGas = BigInt(block.excessBlobGas);
        const gas = fakeExponential(MIN_BLOB_GASPRICE, excessBlobGas, BLOB_GASPRICE_UPDATE_FRACTION);
        return gas * 11n / 10n;
    }

    async getGasPrice(): Promise<ethers.FeeData> {
        return await this.provider.getFeeData();
    }

    async estimateGas(params: any): Promise<bigint | null> {
        const limit = await this.provider.send("eth_estimateGas", [params]);
        if (limit) {
            return BigInt(limit) * 11n / 10n;
        }
        return null;
    }

    async sendTx(
        tx: ethers.TransactionRequest,
        blobs: Uint8Array[] = undefined,
        commitments: Uint8Array[] = undefined
    ): Promise<ethers.TransactionResponse> {
        if (!blobs) {
            return await this.wallet.sendTransaction(tx);
        }

        if (!tx.maxFeePerBlobGas) {
            tx.maxFeePerBlobGas = await this.getBlobGasPrice();
        }

        const kzg = this.kzg;
        const ethersBlobs: ethers.BlobLike[] = [];
        const versionedHashes: string[] = [];

        for (let i = 0; i < blobs.length; i++) {
            const blob = blobs[i];
            const commitment = commitments && commitments.length > i ? commitments[i] : kzg.blobToKzgCommitment(blob);
            const proof = kzg.computeBlobKzgProof(blob, commitment);
            ethersBlobs.push({
                data: blob,
                proof: proof,
                commitment: commitment
            });

            const hash = commitmentsToVersionedHashes(commitment);
            versionedHashes.push(ethers.hexlify(hash));
        }

        // send
        tx.type = 3;
        tx.blobVersionedHashes = versionedHashes;
        tx.blobs = ethersBlobs;
        tx.kzg = kzg;
        return await this.wallet.sendTransaction(tx);
    }

    async sendTxLock(
        tx: ethers.TransactionRequest,
        blobs: Uint8Array[] = undefined,
        commitments: Uint8Array[] = undefined
    ): Promise<ethers.TransactionResponse> {
        const release = await this.mutex.acquire();
        try {
            return await this.sendTx(tx, blobs, commitments);
        } finally {
            release();
        }
    }

    getCommitment(blob: Uint8Array): Uint8Array {
        return this.kzg.blobToKzgCommitment(blob);
    }

    getBlobHash(blob: Uint8Array): string {
        const commit = this.getCommitment(blob);
        return getHash(commit);
    }
}
