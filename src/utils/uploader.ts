import { ethers } from "ethers";
import { Mutex } from 'async-mutex';
import { KZG } from "js-kzg";
import { calcTxCost, computeVersionedCommitmentHash, convertToEthStorageHashes } from "./util";
import { UploadResult } from "../param";

export class BlobUploader {
    private readonly provider: ethers.JsonRpcProvider;
    private readonly wallet: ethers.Wallet;
    private readonly mutex: Mutex;

    private kzgInstance: KZG | null = null;
    private kzgInitPromise: Promise<KZG> | null = null;


    constructor(rpc: string, pk: string) {
        this.provider = new ethers.JsonRpcProvider(rpc);
        this.wallet = new ethers.Wallet(pk, this.provider);
        this.mutex = new Mutex();
    }

    private async getKzg(): Promise<KZG> {
        if (this.kzgInstance) return this.kzgInstance;

        if (!this.kzgInitPromise) {
            this.kzgInitPromise = KZG.create().then(kzg => {
                this.kzgInstance = kzg;
                return kzg;
            });
        }

        return this.kzgInitPromise;
    }

    // api
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

    //  utils
    async computeCommitmentsForBlobs(blobs: Uint8Array[]): Promise<Uint8Array[]> {
        const kzg = await this.getKzg();
        const hexCommitments = await kzg.computeCommitmentBatch(blobs);
        return hexCommitments.map(c => ethers.getBytes(c));
    }

    async computeCellProofsForBlobs(blobs: Uint8Array[]): Promise<ethers.BytesLike[]> {
        const kzg = await this.getKzg();
        const blobProofs = await kzg.computeCellsProofsBatch(blobs);
        return blobProofs.map(p => ethers.concat(p));
    }

    async computeEthStorageHashesForBlobs(blobs: Uint8Array[]): Promise<string[]> {
        const commitments = await this.computeCommitmentsForBlobs(blobs);
        return convertToEthStorageHashes(commitments);
    }

    async getTransactionResult(hash: string): Promise<UploadResult> {
        const txReceipt = await this.provider.waitForTransaction(hash);
        const txCost = calcTxCost(txReceipt);
        return {
            txCost,
            success: txReceipt?.status === 1
        };
    }

    // send tx
    async sendTx(
        tx: ethers.TransactionRequest,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null,
    ): Promise<ethers.TransactionResponse> {
        return await this._send(tx, false, false, blobs, commitments);
    }

    async sendTxLock(
        tx: ethers.TransactionRequest,
        isConfirmedNonce: boolean,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null,
    ): Promise<ethers.TransactionResponse> {
        return await this._send(tx, isConfirmedNonce, true, blobs, commitments,);
    }

    private async _send(
        tx: ethers.TransactionRequest,
        isConfirmedNonce: boolean = false,
        isLock: boolean = false,
        blobs: Uint8Array[] | null = null,
        commitments: Uint8Array[] | null = null,
    ): Promise<ethers.TransactionResponse> {
        if (blobs) {
            // compute commitments and proofs
            const [fullCommitments, cellProofs] = await Promise.all([
                commitments && commitments.length === blobs.length
                    ? Promise.resolve(commitments)
                    : this.computeCommitmentsForBlobs(blobs),
                this.computeCellProofsForBlobs(blobs)
            ]);

            const ethersBlobs: ethers.BlobLike[] = blobs.map((blob, i) => ({
                data: blob,
                proof: cellProofs[i],
                commitment: fullCommitments[i]
            }));

            const versionedHashes = fullCommitments.map(commitment =>
                ethers.hexlify(computeVersionedCommitmentHash(commitment as Uint8Array))
            );

            // EIP-4844 tx
            tx.type = 3;
            tx.blobWrapperVersion = 1;
            tx.blobVersionedHashes = versionedHashes;
            tx.blobs = ethersBlobs;
            tx.maxFeePerBlobGas ??= await this.getBlobGasPrice();
        }

        const sendFunc = async () => {
            if (isConfirmedNonce) {
                tx.nonce = await this.provider.getTransactionCount(this.wallet.address, "latest");
            }
            return await this.wallet.sendTransaction(tx);
        };

        if (isLock) {
            const release = await this.mutex.acquire();
            try {
                return await sendFunc();
            } finally {
                release();
            }
        } else {
            return await sendFunc();
        }
    }

    async close(): Promise<void> {
        if (this.kzgInstance) {
            await this.kzgInstance.terminate();
            this.kzgInstance = null;
        }
    }
}
