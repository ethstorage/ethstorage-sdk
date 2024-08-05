import {ethers} from "ethers";
import {loadKZG} from 'kzg-wasm';
import {Mutex} from 'async-mutex';

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
        return await this.#wallet.getNonce("pending");
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

    async #populate(tx, blobs) {
        if (!blobs) {
            return tx;
        }

        if (tx.maxFeePerBlobGas == null) {
            tx.maxFeePerBlobGas = await this.getBlobGasPrice();
        }

        // blobs
        const kzg = this.#kzg;
        const ethersBlobs = [];
        const versionedHashes = [];
        for (let i = 0; i < blobs.length; i++) {
            const blob = blobs[i];
            const commitment = kzg.blobToKzgCommitment(blob);
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
        return tx;
    }

    async sendTx(tx, blobs) {
        const txObj = await this.#populate(tx, blobs);
        return await this.#wallet.sendTransaction(txObj);
    }

    async #sendTxLock(tx) {
        const release = await this.#mutex.acquire();
        try {
            tx.nonce = await this.getNonce();
            return await this.#wallet.provider.broadcastTransaction(await this.#wallet.signTransaction(tx));
        } finally {
            release();
        }
    }

    async sendTxLock(tx, blobs) {
        const txObj = await this.#populate(tx, blobs);

        // init
        txObj.nonce = 0;
        const pop = await this.#wallet.populateTransaction(tx);
        delete pop.from;
        tx = ethers.Transaction.from(pop);
        return await this.#sendTxLock(tx);
    }

    getBlobHash(blob) {
        const kzg = this.#kzg;
        const commit = kzg.blobToKzgCommitment(blob);
        const localHash = commitmentsToVersionedHashes(commit);
        const hash = new Uint8Array(32);
        hash.set(localHash.subarray(0, 32 - 8));
        return ethers.hexlify(hash);
    }
}
