import { ethers } from "ethers";
import { Mutex } from 'async-mutex';
import { computeVersionedCommitmentHash, convertToEthStorageHash, convertToEthStorageHashes } from "./util";
import { KZG } from "js-kzg";

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
    private readonly provider: ethers.JsonRpcProvider;
    private readonly wallet: ethers.Wallet;
    private readonly mutex: Mutex;
    private readonly kzg: KZG;

    constructor(rpc: string, pk: string) {
        this.provider = new ethers.JsonRpcProvider(rpc);
        this.wallet = new ethers.Wallet(pk, this.provider);
        this.mutex = new Mutex();
        this.kzg = new KZG();
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

    async sendTx(
        tx: ethers.TransactionRequest,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null,
    ): Promise<ethers.TransactionResponse> {
        return await this.send(tx, blobs, commitments, false);
    }

    async sendTxLock(
        tx: ethers.TransactionRequest,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null,
    ): Promise<ethers.TransactionResponse> {
        return await this.send(tx, blobs, commitments, true);
    }

    private async send(
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
        const fullCommitments = commitments && commitments.length === blobs.length
            ? commitments
            : await this.kzg.computeCommitmentBatch(blobs);
        const proofs = await this.kzg.computeProofBatch(blobs, fullCommitments);

        const ethersBlobs: ethers.BlobLike[] = blobs.map((blob, i) => ({
            data: blob,
            proof: proofs[i],
            commitment: fullCommitments[i]
        }));

        const versionedHashes = fullCommitments.map(commitment =>
            ethers.hexlify(computeVersionedCommitmentHash(commitment))
        );

        // send
        tx.type = 3;
        tx.blobVersionedHashes = versionedHashes;
        tx.blobs = ethersBlobs;
        return isLock ? await this.lockSend(tx) : await this.wallet.sendTransaction(tx);
    }

    private async lockSend(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
        const release = await this.mutex.acquire();
        try {
            return await this.wallet.sendTransaction(tx);
        } finally {
            release();
        }
    }

    async computeCommitmentsForBlobs(blobs: Uint8Array[]): Promise<Uint8Array[]> {
        return await this.kzg.computeCommitmentBatch(blobs);
    }

    async computeEthStorageHashForBlob(blob: Uint8Array): Promise<string> {
        const commit = await this.kzg.computeCommitment(blob);
        return convertToEthStorageHash(commit);
    }

    async computeEthStorageHashesForBlobs(blobs: Uint8Array[]): Promise<string[]> {
        const commitments = await this.computeCommitmentsForBlobs(blobs);
        return convertToEthStorageHashes(commitments);
    }

    async close(): Promise<void> {
        await this.kzg.close();
    }
}
