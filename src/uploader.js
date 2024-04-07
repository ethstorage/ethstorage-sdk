const {ethers} = require("ethers");
const {BlobEIP4844Transaction} = require("@ethereumjs/tx");
const {Common} = require("@ethereumjs/common");
const {loadKZG} = require('kzg-wasm');

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

class BlobUploader {
    #kzg;
    #jsonRpc;
    #privateKey;
    #provider;
    #wallet;
    #chainId;

    constructor(rpc, pk) {
        this.#jsonRpc = rpc;
        this.#privateKey = padHex(pk);
        this.#provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(this.#privateKey, this.#provider);
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
            if(response.data.error) {
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

    async sendRawTransaction(param) {
        return await this.sendRpcCall("eth_sendRawTransaction", [param]);
    }

    async getChainId() {
        if (this.#chainId == null) {
            this.#chainId = await this.sendRpcCall("eth_chainId", []);
        }
        return this.#chainId;
    }

    async getNonce() {
        return await this.#wallet.getNonce();
    }

    async getFee() {
        return await this.#provider.getFeeData();
    }

    async getBlobGasPrice() {
        // get current block
        const block = await this.#provider.getBlock("latest");
        const result = await this.sendRpcCall("eth_getBlockByNumber", [
            parseBigintValue(BigInt(block.number)), true
        ]);
        const excessBlobGas = BigInt(result.excessBlobGas);
        return fakeExponential(MIN_BLOB_GASPRICE, excessBlobGas ,BLOB_GASPRICE_UPDATE_FRACTION);
    }

    async estimateGas(params) {
        const limit = await this.sendRpcCall("eth_estimateGas", [params]);
        if (limit) {
            return BigInt(limit);
        }
        return null;
    }

    async sendNormalTx(tx) {
        let {chainId, nonce, to, value, data, maxPriorityFeePerGas, maxFeePerGas, gasLimit} = tx;
        const txResponse = await this.#wallet.sendTransaction({
            chainId,
            nonce,
            to,
            value,
            data,
            maxPriorityFeePerGas,
            maxFeePerGas,
            gasLimit,
        });
        return txResponse.hash;
    }

    async sendTx(tx, blobs) {
        if (!blobs) {
            return this.sendNormalTx(tx);
        }

        // blobs
        const kzg = await this.#getKzg();
        const commitments = [];
        const proofs = [];
        const versionedHashes = [];
        const hexHashes = [];
        for (let i = 0; i < blobs.length; i++) {
            commitments.push(kzg.blobToKzgCommitment(blobs[i]));
            proofs.push(kzg.computeBlobKzgProof(blobs[i], commitments[i]));
            const hash = commitmentsToVersionedHashes(commitments[i]);
            versionedHashes.push(hash);
            hexHashes.push(ethers.hexlify(hash));
        }

        const chain = await this.getChainId();
        let {chainId, nonce, to, value, data, maxPriorityFeePerGas, maxFeePerGas, gasLimit, maxFeePerBlobGas} = tx;
        if (chainId == null) {
            chainId = chain;
        } else {
            chainId = BigInt(chainId);
            if (chainId !== BigInt(chain)) {
                throw Error('invalid network id')
            }
        }

        if (nonce == null) {
            nonce = await this.getNonce();
        }

        value = value == null ? '0x0' : BigInt(value);

        if (gasLimit == null) {
            const hexValue = parseBigintValue(value);
            const params = {
                from: this.#wallet.address,
                to,
                data,
                value: hexValue,
                blobVersionedHashes: hexHashes,
            };
            gasLimit = await this.estimateGas(params);
            if (gasLimit == null) {
                throw Error('estimateGas: execution reverted')
            }
        } else {
            gasLimit = BigInt(gasLimit);
        }

        if (maxFeePerGas == null) {
            const fee = await this.getFee();
            maxPriorityFeePerGas = fee.maxPriorityFeePerGas * 6n / 5n;
            maxFeePerGas = fee.maxFeePerGas * 6n / 5n;
        } else {
            maxFeePerGas = BigInt(maxFeePerGas);
            maxPriorityFeePerGas = BigInt(maxPriorityFeePerGas);
        }

        if (maxFeePerBlobGas == null) {
            maxFeePerBlobGas = await this.getBlobGasPrice();
            maxFeePerBlobGas = maxFeePerBlobGas * 6n / 5n;
        } else {
            maxFeePerBlobGas = BigInt(maxFeePerBlobGas);
        }


        // send
        const common = Common.custom(
            {
                name: 'custom-chain',
                networkId: chainId,
                chainId: chainId,
            },
            {
                baseChain: 1,
                eips: [1559, 3860, 4844]
            }
        );
        const unsignedTx = new BlobEIP4844Transaction(
            {
                chainId,
                nonce,
                to,
                value,
                data,
                maxPriorityFeePerGas,
                maxFeePerGas,
                gasLimit,
                maxFeePerBlobGas,
                blobVersionedHashes: versionedHashes,
                blobs,
                kzgCommitments: commitments,
                kzgProofs: proofs,
            },
            {common}
        );

        const pk = ethers.getBytes(this.#privateKey);
        const signedTx = unsignedTx.sign(pk);
        const rawData = signedTx.serializeNetworkWrapper();

        const hex = Buffer.from(rawData).toString('hex');
        return await this.sendRawTransaction('0x' + hex);
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

    async getBlobHash(blob) {
        const kzg = await this.#getKzg();
        const commit = kzg.blobToKzgCommitment(blob);
        const localHash = commitmentsToVersionedHashes(commit);
        const hash = new Uint8Array(32);
        hash.set(localHash.subarray(0, 32 - 8));
        return ethers.hexlify(hash);
    }
}

module.exports = {
    BlobUploader
}
