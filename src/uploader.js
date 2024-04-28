import {ethers} from "ethers";
import {loadKZG} from 'kzg-wasm';

const defaultAxios = require("axios");
const axios = defaultAxios.create({
    timeout: 50000,
});

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function parseBigintValue(value) {
    if (typeof value == 'bigint') {
        return '0x' + value.toString(16);
    }
    if (typeof value == 'object') {
        const {_hex} = value;
        const c = BigInt(_hex);
        return '0x' + c.toString(16);
    }
    return value;
}

function padHex(hex) {
    if (typeof (hex) === "string" && !hex.startsWith("0x")) {
        return "0x" + hex;
    }
    return hex;
}

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

    #jsonRpc;
    #provider;
    #wallet;

    constructor(rpc, pk) {
        this.#jsonRpc = rpc;
        this.#provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(padHex(pk), this.#provider);
    }

    async #getKzg() {
        if (!this.#kzg) {
            this.#kzg = await loadKZG();
        }
        return this.#kzg;
    }

    async sendRpcCall(method, parameters) {
        try {
            let response = await axios({
                method: "POST",
                url: this.#jsonRpc,
                data: {
                    jsonrpc: "2.0",
                    method: method,
                    params: parameters,
                    id: 67
                },
            });
            if (response.data.error) {
                console.log("Response Error:", response.data.error);
                return null;
            }
            let returnedValue = response.data.result;
            if (returnedValue === "0x") {
                return null;
            }
            return returnedValue;
        } catch (error) {
            console.log('send error', error);
            return null;
        }
    }

    async getNonce() {
        return await this.#wallet.getNonce();
    }

    async getBlobGasPrice() {
        // get current block
        const block = await this.#provider.getBlock("latest");
        const excessBlobGas = BigInt(block.excessBlobGas);
        return fakeExponential(MIN_BLOB_GASPRICE, excessBlobGas, BLOB_GASPRICE_UPDATE_FRACTION);
    }

    async getGasPrice() {
        return await this.#provider.getFeeData();
    }

    async estimateGas(params) {
        const limit = await this.sendRpcCall("eth_estimateGas", [params]);
        if (limit) {
            return BigInt(limit);
        }
        return null;
    }

    async sendTx(tx, blobs) {
        if (!blobs) {
            return await this.#wallet.sendTransaction(tx);
        }

        // blobs
        const kzg = await this.#getKzg();
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

        let {to, value, data, gasLimit, maxFeePerBlobGas} = tx;
        if (gasLimit == null) {
            const hexValue = parseBigintValue(value);
            const params = {
                from: this.#wallet.address,
                to,
                data,
                value: hexValue,
                blobVersionedHashes: versionedHashes,
            };
            gasLimit = await this.estimateGas(params);
            if (gasLimit == null) {
                throw Error('estimateGas: execution reverted')
            }
            tx.gasLimit = gasLimit;
        }

        if (maxFeePerBlobGas == null) {
            maxFeePerBlobGas = await this.getBlobGasPrice();
            maxFeePerBlobGas = maxFeePerBlobGas * 6n / 5n;
            tx.maxFeePerBlobGas = maxFeePerBlobGas;
        }

        // send
        tx.type = 3;
        tx.blobVersionedHashes = versionedHashes;
        tx.blobs = ethersBlobs;
        tx.kzg = kzg;
        return await this.#wallet.sendTransaction(tx);
    }

    async getBlobHash(blob) {
        const kzg = await this.#getKzg();
        const commit = kzg.blobToKzgCommitment(blob);
        const localHash = commitmentsToVersionedHashes(commit);
        const hash = new Uint8Array(32);
        hash.set(localHash.subarray(0, 32 - 8));
        return ethers.hexlify(hash);
    }

    async isTransactionMined(transactionHash) {
        const txReceipt = await this.#provider.getTransactionReceipt(transactionHash);
        if (txReceipt && txReceipt.blockNumber) {
            return txReceipt;
        }
    }

    async getTxReceipt(transactionHash) {
        let txReceipt;
        while (!txReceipt) {
            txReceipt = await this.isTransactionMined(transactionHash);
            if (txReceipt) break;
            await sleep(5000);
        }
        return txReceipt;
    }
}
