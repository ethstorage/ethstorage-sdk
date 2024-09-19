import {ethers} from "ethers";
import {loadKZG} from 'kzg-wasm';
import {Mutex} from 'async-mutex';
import {getHash, commitmentsToVersionedHashes} from "./util";

// blob gas price
const MIN_BLOB_GASPRICE = 1n;
const BLOB_GASPRICE_UPDATE_FRACTION = 3338477n;

function fakeExponential(factor, numerator, denominator) {
    let i = 1n;
    let output = 0n;
    let numerator_accum = factor * denominator;
    while (numerator_accum > 0n) {
        output += numerator_accum;
        numerator_accum = (numerator_accum * numerator) / (denominator * i);
        i++;
    }
    return output / denominator;
}

export class BlobUploader {
    #kzg;

    #provider;
    #wallet;
    #mutex;

    static async create(rpc, pk) {
        const uploader = new BlobUploader(rpc, pk);
        await uploader.init();
        return uploader;
    }

    constructor(rpc, pk) {
        this.#provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(pk, this.#provider);
        this.#mutex = new Mutex();
    }

    async init() {
        if (!this.#kzg) {
            this.#kzg = await loadKZG();
        }
        return this.#kzg;
    }

    async getNonce() {
        return await this.#wallet.getNonce();
    }

    async getBlobGasPrice() {
        // get current block
        const block = await this.#provider.getBlock("latest");
        const excessBlobGas = BigInt(block.excessBlobGas);
        const gas = fakeExponential(MIN_BLOB_GASPRICE, excessBlobGas, BLOB_GASPRICE_UPDATE_FRACTION);
        return gas * 11n / 10n;
    }

    async getGasPrice() {
        return await this.#provider.getFeeData();
    }

    async estimateGas(params) {
        const limit = await this.#provider.send("eth_estimateGas", [params]);
        if (limit) {
            return BigInt(limit) * 11n / 10n;
        }
        return null;
    }

    async #preSend(tx, blobs = null, commitments = null, isLock = false) {
        if (!blobs) {
            return isLock ? await this.#lockSend(tx) : await this.#wallet.sendTransaction(tx);
        }

        if (tx.maxFeePerBlobGas == null) {
            tx.maxFeePerBlobGas = await this.getBlobGasPrice();
        }

        // blobs
        const [ethersBlobs, versionedHashes] = await this.#processBlobs(blobs, commitments);

        // send
        tx.type = 3;
        tx.blobVersionedHashes = versionedHashes;
        tx.blobs = ethersBlobs;
        tx.kzg = this.#kzg;
        return isLock ? await this.#lockSend(tx) : await this.#wallet.sendTransaction(tx);
    }

    async #processBlobs(blobs, commitments) {
        const ethersBlobs = [];
        const versionedHashes = [];

        const blobPromises = blobs.map(async (blob, index) => {
            const commitment = (commitments && commitments.length > index) ? commitments[index] : this.#kzg.blobToKzgCommitment(blob);
            const proof = this.#kzg.computeBlobKzgProof(blob, commitment);

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

    async #lockSend(tx) {
        const release = await this.#mutex.acquire();
        try {
            return await this.#wallet.sendTransaction(tx);
        } finally {
            release();
        }
    }

    async sendTx(tx, blobs = null, commitments = null) {
        return await this.#preSend(tx, blobs, commitments, false);
    }

    async sendTxLock(tx, blobs = null, commitments = null) {
        return await this.#preSend(tx, blobs, commitments, true);
    }

    getCommitment(blob) {
        return this.#kzg.blobToKzgCommitment(blob);
    }

    getBlobHash(blob) {
        const commit = this.getCommitment(blob);
        return getHash(commit);
    }
}
