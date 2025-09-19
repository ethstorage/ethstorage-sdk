import { ethers } from "ethers";
import { Mutex } from 'async-mutex';
import { KZG } from "js-kzg";
import { calcTxCost, computeVersionedCommitmentHash, convertToEthStorageHashes } from "./util";
import { UploadResult } from "../param";

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
        const response = await this.provider.send("eth_blobBaseFee", []);
        if (!response) {
            throw new Error("eth_blobBaseFee RPC returned empty response");
        }
        return BigInt(response) * 11n / 10n;
    }

    async getGasPrice(): Promise<ethers.FeeData> {
        return await this.provider.getFeeData();
    }

    async sendTx(
        tx: ethers.TransactionRequest,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null,
    ): Promise<ethers.TransactionResponse> {
        return await this.send(tx, false, blobs, commitments, false);
    }

    async sendTxLock(
        tx: ethers.TransactionRequest,
        isConfirmedNonce: boolean,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null,
    ): Promise<ethers.TransactionResponse> {
        return await this.send(tx, isConfirmedNonce, blobs, commitments, true);
    }

    private async send(
        tx: ethers.TransactionRequest,
        isConfirmedNonce: boolean,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null,
        isLock: boolean = false
    ): Promise<ethers.TransactionResponse> {
        if (isConfirmedNonce) {
            tx.nonce = await this.provider.getTransactionCount(this.wallet.address, "latest");
        }

        if (!blobs) {
            return isLock ? await this.lockSend(tx) : await this.wallet.sendTransaction(tx);
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

        tx.maxFeePerBlobGas ??= await this.getBlobGasPrice();

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

    async computeEthStorageHashesForBlobs(blobs: Uint8Array[]): Promise<string[]> {
        const commitments = await this.computeCommitmentsForBlobs(blobs);
        return convertToEthStorageHashes(commitments);
    }

    async getTransactionResult(hash: string): Promise<UploadResult> {
        const txResponse = await this.provider.getTransaction(hash);
        if (!txResponse) throw new Error("tx not found");

        const txReceipt = await txResponse.wait();
        const txCost = calcTxCost(txReceipt);
        return {
            txCost,
            success: txReceipt?.status === 1
        };
    }

    async close(): Promise<void> {
        await this.kzg.close();
    }
}
