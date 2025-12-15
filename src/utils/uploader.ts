import { ethers } from "ethers";
import { Mutex } from "async-mutex";
import { KZG } from "js-kzg";
import {
    calcTxCost, computeVersionedCommitmentHash,
    convertToEthStorageHashes, retry
} from "./util";
import { UploadResult } from "../param";

// ====================== Constants ======================
const BLOB_TX = {
    TYPE: 3 as const,
    WRAPPER_VERSION: 1 as const,
    DEFAULT_GAS_INC_PCT: 0 as const,
    RETRIES: 3 as const,
};

export const EMPTY_BLOB_CONSTANTS = {
    // 128KB full 0
    DATA: new Uint8Array(131072),
    COMMITMENT: ethers.getBytes("0xc00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
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
        return this.#initPromise!;
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
    confirmNonce: boolean;
};

type BuildBlobTxParams = {
    baseTx: ethers.TransactionRequest;
    blobs: Uint8Array[];
    commitments?: Uint8Array[];
    gasIncPct?: number;
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
        const base = await retry(() => this.#provider.send("eth_blobBaseFee", []), BLOB_TX.RETRIES);
        if (!base) throw new Error("RPC returned empty response");

        return BigInt(base) * 11n / 10n;
    }

    async getGasPrice(): Promise<ethers.FeeData> {
        return await retry(() => this.#provider.getFeeData(), BLOB_TX.RETRIES);
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
        if (!hash || !ethers.isHexString(hash)) throw new Error("Invalid transaction hash");
        const receipt = await retry(() => this.#provider.waitForTransaction(hash), BLOB_TX.RETRIES);
        return {txCost: calcTxCost(receipt), success: receipt?.status === 1};
    }

    /**
     * Computes KZG commitments and cell proofs for the given blobs,
     * then constructs an EIP-4844 transaction request with the corresponding fields.
     */
    async buildBlobTx(params: BuildBlobTxParams): Promise<ethers.TransactionRequest> {
        const {baseTx, blobs, commitments, gasIncPct = BLOB_TX.DEFAULT_GAS_INC_PCT} = params;
        if (gasIncPct < 0) {
            throw new Error("Gas increase percentage cannot be negative");
        }

        // blob
        const fullCommitments = commitments?.length === blobs.length
            ? commitments : await this.#kzg.computeCommitments(blobs);
        const cellProofs = await this.#kzg.computeCellProofs(blobs);

        const ethersBlobs: ethers.BlobLike[] = blobs.map((blob, i) => ({
            data: blob,
            commitment: fullCommitments[i],
            proof: cellProofs[i],
        }));

        // Compute Versioned Hashes from Commitments
        const versionedHashes = fullCommitments.map((c) =>
            ethers.hexlify(computeVersionedCommitmentHash(c as Uint8Array))
        );

        const tx: ethers.TransactionRequest = {
            ...baseTx,
            type: BLOB_TX.TYPE,
            blobWrapperVersion: BLOB_TX.WRAPPER_VERSION,
            blobVersionedHashes: versionedHashes,
            blobs: ethersBlobs,

            maxFeePerBlobGas: baseTx.maxFeePerBlobGas ?? (await this.getBlobGasPrice()),
        };

        // optionally bump gas
        if (gasIncPct > 0) {
            const feeData = await this.getGasPrice();
            tx.maxFeePerGas = feeData.maxFeePerGas! * BigInt(100 + gasIncPct) / BigInt(100);
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas! * BigInt(100 + gasIncPct) / BigInt(100);
            tx.maxFeePerBlobGas = tx.maxFeePerBlobGas * BigInt(100 + gasIncPct) / BigInt(100);
        }

        return tx;
    }

    // ====================== Public Send API ======================
    /**
     * Sends a transaction without using the Mutex lock.
     */
    async sendTx(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
        return this.#send({tx, confirmNonce: false});
    }

    /**
     * Sends a transaction using the Mutex lock to ensure sequential submission.
     */
    async sendTxLock(
        tx: ethers.TransactionRequest,
        confirmNonce: boolean,
    ): Promise<ethers.TransactionResponse> {
        return this.#send({tx, confirmNonce, useLock: true});
    }

    /**
     * Cleans up resources, specifically terminating the KZG WASM instance.
     */
    async close() {
        await this.#kzg.destroy();
    }

    // ====================== Internal Core Logic ======================
    /**
     * Core handler: Prepares blob data (if needed), applies lock (if requested), and sends.
     */
    async #send(params: SendTxParams & { useLock?: boolean }): Promise<ethers.TransactionResponse> {
        const {tx, useLock = false, confirmNonce} = params;

        // Atomic Submission (Locked if requested)
        if (useLock) {
            const release = await this.#mutex.acquire();
            try {
                return await this.#atomicSend(tx, confirmNonce);
            } finally {
                release();
            }
        }

        // Unlocked submission
        return this.#atomicSend(tx, confirmNonce);
    }

    /**
     * Handles nonce management and transaction submission.
     */
    async #atomicSend(
        tx: ethers.TransactionRequest,
        confirmNonce: boolean
    ): Promise<ethers.TransactionResponse> {
        return retry(async () => {
            if (confirmNonce) {
                tx.nonce = await this.#provider.getTransactionCount(
                    this.#wallet.address,
                    "latest"
                );
            }
            return this.#wallet.sendTransaction(tx);
        }, BLOB_TX.RETRIES);
    }
}
