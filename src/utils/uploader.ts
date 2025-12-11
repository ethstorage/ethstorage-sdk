import { ethers } from "ethers";
import { Mutex } from "async-mutex";
import { KZG } from "js-kzg";
import { calcTxCost, computeVersionedCommitmentHash, convertToEthStorageHashes } from "./util";
import { UploadResult } from "../param";

// ====================== Constants ======================
const BLOB_TX = {
    TYPE: 3 as const,
    WRAPPER_VERSION: 1 as const,
    // 11n / 10n = 1.1x multiplier
    BASE_FEE_MULTIPLIER: 11n / 10n,
};

// ====================== KZG Helper ======================
/**
 * Handles KZG initialization (lazy loading) and computations.
 */
class KzgHelper {
    #instance: KZG | null = null;
    #initPromise: Promise<KZG> | null = null;

    async getInstance(): Promise<KZG> {
        if (this.#instance) return this.#instance;

        if (!this.#initPromise) {
            this.#initPromise = this.#initialize();
        }
        return this.#initPromise;
    }

    async #initialize(): Promise<KZG> {
        const kzg = await KZG.create();
        this.#instance = kzg;
        return kzg;
    }

    async computeCommitments(blobs: Uint8Array[]): Promise<Uint8Array[]> {
        const kzg = await this.getInstance();
        const hex = await kzg.computeCommitmentBatch(blobs);
        return hex.map((h) => ethers.getBytes(h));
    }

    async computeCellProofs(blobs: Uint8Array[]): Promise<ethers.BytesLike[]> {
        const kzg = await this.getInstance();
        const proofs = await kzg.computeCellsProofsBatch(blobs);
        return proofs.map((p) => ethers.concat(p));
    }

    async destroy() {
        if (this.#instance) {
            await this.#instance.terminate();
            this.#instance = null;
            this.#initPromise = null;
        }
    }
}

// ====================== Types ======================
type SendTxParams = {
    tx: ethers.TransactionRequest;
    blobs?: Uint8Array[];
    commitments?: Uint8Array[];
    useLock: boolean;
    confirmNonce: boolean;
};

// ====================== Main Class ======================
export class BlobUploader {
    readonly #provider: ethers.JsonRpcProvider;
    readonly #wallet: ethers.Wallet;
    // Mutex for serializing nonce fetching and transaction submission
    readonly #mutex = new Mutex();
    // KZG Helper for lazy initialization and computation
    readonly #kzg = new KzgHelper();

    constructor(rpc: string, privateKey: string) {
        this.#provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(privateKey, this.#provider);
    }

    // ====================== Gas API ======================
    async getBlobGasPrice(): Promise<bigint> {
        const base = await this.#provider.send("eth_blobBaseFee", []);
        if (!base) throw new Error("RPC returned empty response");

        return BigInt(base) * BLOB_TX.BASE_FEE_MULTIPLIER;
    }

    async getGasPrice(): Promise<ethers.FeeData> {
        return await this.#provider.getFeeData();
    }

    // ====================== Blob Utility API ======================
    async computeCommitmentsForBlobs(blobs: Uint8Array[]): Promise<Uint8Array[]> {
        return await this.#kzg.computeCommitments(blobs);
    }

    async computeEthStorageHashesForBlobs(blobs: Uint8Array[]): Promise<string[]> {
        const com = await this.#kzg.computeCommitments(blobs);
        return convertToEthStorageHashes(com);
    }

    async getTransactionResult(hash: string): Promise<UploadResult> {
        const receipt = await this.#provider.waitForTransaction(hash);
        return { txCost: calcTxCost(receipt), success: receipt?.status === 1 };
    }

    // ====================== Public Send API ======================
    /**
     * Sends a transaction without using the Mutex lock.
     */
    async sendTx(
        tx: ethers.TransactionRequest,
        blobs?: Uint8Array[],
        commitments?: Uint8Array[]
    ): Promise<ethers.TransactionResponse> {
        return this.#send({ tx, blobs, commitments, useLock: false, confirmNonce: false });
    }

    /**
     * Sends a transaction using the Mutex lock to ensure sequential submission.
     */
    async sendTxLock(
        tx: ethers.TransactionRequest,
        confirmNonce: boolean,
        blobs?: Uint8Array[],
        commitments?: Uint8Array[]
    ): Promise<ethers.TransactionResponse> {
        return this.#send({
            tx,
            blobs,
            commitments,
            useLock: true,
            confirmNonce,
        });
    }

    // ====================== Internal Core Logic ======================
    /**
     * Core handler: Prepares blob data (if needed), applies lock (if requested), and sends.
     */
    async #send(params: SendTxParams): Promise<ethers.TransactionResponse> {
        const { tx, blobs, commitments, useLock, confirmNonce } = params;

        // 1. Transaction Preparation (Non-locked, CPU intensive work is done here)
        const finalTx = blobs
            ? await this.#buildBlobTxParams({ ...tx }, blobs, commitments)
            : { ...tx };

        // 2. Atomic Submission (Locked if requested)
        if (useLock) {
            const release = await this.#mutex.acquire();
            try {
                return await this.#atomicSend(finalTx, confirmNonce);
            } finally {
                release();
            }
        }

        // Unlocked submission
        return this.#atomicSend(finalTx, confirmNonce);
    }

    /**
     * Handles nonce management and transaction submission.
     */
    async #atomicSend(
        tx: ethers.TransactionRequest,
        confirmNonce: boolean
    ): Promise<ethers.TransactionResponse> {
        if (confirmNonce) {
            tx.nonce = await this.#provider.getTransactionCount(
                this.#wallet.address,
                "latest"
            );
        }
        return this.#wallet.sendTransaction(tx);
    }

    /**
     * Computes KZG fields and populates EIP-4844 specific transaction parameters.
     * This section is optimized for concurrency via Promise.all.
     */
    async #buildBlobTxParams(
        tx: ethers.TransactionRequest,
        blobs: Uint8Array[],
        commitments?: Uint8Array[]
    ): Promise<ethers.TransactionRequest> {
        // Concurrently compute Commitments and Proofs (CPU-bound)
        const [fullCommitments, cellProofs] = await Promise.all([
            commitments?.length === blobs.length
                ? Promise.resolve(commitments)
                : this.#kzg.computeCommitments(blobs),
            this.#kzg.computeCellProofs(blobs),
        ]);

        const ethersBlobs: ethers.BlobLike[] = blobs.map((blob, i) => ({
            data: blob,
            commitment: fullCommitments[i],
            proof: cellProofs[i],
        }));

        // Compute Versioned Hashes from Commitments
        const versionedHashes = fullCommitments.map((c) =>
            ethers.hexlify(computeVersionedCommitmentHash(c as Uint8Array))
        );

        return {
            ...tx,
            type: BLOB_TX.TYPE,
            blobWrapperVersion: BLOB_TX.WRAPPER_VERSION,
            blobVersionedHashes: versionedHashes,
            blobs: ethersBlobs,
            maxFeePerBlobGas: tx.maxFeePerBlobGas ?? (await this.getBlobGasPrice()),
        };
    }

    /**
     * Cleans up resources, specifically terminating the KZG WASM instance.
     */
    async close() {
        await this.#kzg.destroy();
    }
}
