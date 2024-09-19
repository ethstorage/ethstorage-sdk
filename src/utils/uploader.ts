import { ethers } from "ethers";
import { loadKZG } from 'kzg-wasm';
import { Mutex } from 'async-mutex';
import { getHash, commitmentsToVersionedHashes } from "./util";
import { KZG } from "../param";

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

export class BlobUploader {
    private kzg!: KZG;

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

    private async init() {
        if (!this.kzg) {
            this.kzg = await loadKZG();
        }
    }

    async getBlobGasPrice(): Promise<bigint> {
        // get current block
        const block = await this.provider.getBlock("latest");
        if (block === null || block.excessBlobGas === null) {
            throw new Error("Block has no excessBlobGas");
        }
        const excessBlobGas = BigInt(block.excessBlobGas);
        const gas = fakeExponential(MIN_BLOB_GASPRICE, excessBlobGas, BLOB_GASPRICE_UPDATE_FRACTION);
        return gas * 11n / 10n;
    }

    async getGasPrice(): Promise<ethers.FeeData> {
        return await this.provider.getFeeData();
    }

    private async preSend(
        tx: ethers.TransactionRequest,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null,
        isLock: boolean = false
    ): Promise<ethers.TransactionResponse> {
        if (!blobs) {
            return isLock ? await this.lockSend(tx) : await this.wallet.sendTransaction(tx);
        }

        if (tx.maxFeePerBlobGas == null) {
            tx.maxFeePerBlobGas = await this.getBlobGasPrice();
        }

        // blobs
        const [ethersBlobs, versionedHashes] = await this.processBlobs(blobs, commitments);

        // send
        tx.type = 3;
        tx.blobVersionedHashes = versionedHashes;
        tx.blobs = ethersBlobs;
        tx.kzg = this.kzg;
        return isLock ? await this.lockSend(tx) : await this.wallet.sendTransaction(tx);
    }

    private async processBlobs(
        blobs: Uint8Array[],
        commitments: Uint8Array[] | null
    ): Promise<[ethers.BlobLike[], string[]]> {
        const ethersBlobs: ethers.BlobLike[] = [];
        const versionedHashes: string[] = [];

        const blobPromises = blobs.map(async (blob, index) => {
            const commitment = (commitments && commitments.length > index) ? commitments[index] : this.getCommitment(blob);
            const proof = this.kzg.computeBlobKzgProof(blob, commitment);

            ethersBlobs.push({
                data: blob,
                proof: proof,
                commitment: commitment
            });

            const hash = commitmentsToVersionedHashes(commitment);
            versionedHashes.push(ethers.hexlify(hash));
        });

        await Promise.all(blobPromises);
        return [ethersBlobs, versionedHashes];
    }

    private async lockSend(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
        const release = await this.mutex.acquire();
        try {
            return await this.wallet.sendTransaction(tx);
        } finally {
            release();
        }
    }

    async sendTx(
        tx: ethers.TransactionRequest,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null
    ): Promise<ethers.TransactionResponse> {
        return await this.preSend(tx, blobs, commitments, false);
    }

    async sendTxLock(
        tx: ethers.TransactionRequest,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null
    ): Promise<ethers.TransactionResponse> {
        return await this.preSend(tx, blobs, commitments, true);
    }

    getCommitment(blob: Uint8Array): Uint8Array {
        return this.kzg.blobToKzgCommitment(blob);
    }

    getBlobHash(blob: Uint8Array): string {
        const commit = this.getCommitment(blob);
        return getHash(commit);
    }
}
