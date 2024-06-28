'use strict';

var ethers = require('ethers');
var kzgWasm = require('kzg-wasm');

const stringToHex$1 = (s) => ethers.ethers.hexlify(ethers.ethers.toUtf8Bytes(s));

async function getChainId(rpc) {
    const provider = new ethers.ethers.JsonRpcProvider(rpc);
    const network = await provider.getNetwork();
    return Number(network.chainId);
}

const BlobTxBytesPerFieldElement$1         = 32;      // Size in bytes of a field element
const BlobTxFieldElementsPerBlob$1         = 4096;
const BLOB_SIZE$1 = BlobTxBytesPerFieldElement$1 * BlobTxFieldElementsPerBlob$1;

function encodeBlobs(data) {
    const len = data.length;
    if (len === 0) {
        throw Error('Blobs: invalid blob data')
    }

    let blobIndex = 0;
    let fieldIndex = -1;

    const blobs = [new Uint8Array(BLOB_SIZE$1).fill(0)];
    for (let i = 0; i < len; i += 31) {
        fieldIndex++;
        if (fieldIndex === BlobTxFieldElementsPerBlob$1) {
            blobs.push(new Uint8Array(BLOB_SIZE$1).fill(0));
            blobIndex++;
            fieldIndex = 0;
        }
        let max = i + 31;
        if (max > len) {
            max = len;
        }
        blobs[blobIndex].set(data.subarray(i, max), fieldIndex * 32 + 1);
    }
    return blobs;
}

function decodeBlob(blob) {
    if (!blob) {
        throw Error('Blobs: invalid blob data')
    }

    blob = ethers.ethers.getBytes(blob);
    if (blob.length < BLOB_SIZE$1) {
        const newBlob = new Uint8Array(BLOB_SIZE$1).fill(0);
        newBlob.set(blob);
        blob = newBlob;
    }

    let data = [];
    let j = 0;
    for (let i = 0; i < BlobTxFieldElementsPerBlob$1; i++) {
        const chunk = blob.subarray(j + 1, j + 32);
        data = [...data, ...chunk];
        j += 32;
    }
    let i = data.length - 1;
    for (; i >= 0; i--) {
        if (data[i] !== 0x00) {
            break
        }
    }
    return data.slice(0, i + 1);
}

function decodeBlobs(blobs) {
    if (!blobs) {
        throw Error('Blobs: invalid blobs')
    }

    blobs = ethers.ethers.getBytes(blobs);
    const len = blobs.length;
    if (len === 0) {
        throw Error('Blobs: invalid blobs')
    }

    let buf = [];
    for (let i = 0; i < len; i += BLOB_SIZE$1) {
        let max = i + BLOB_SIZE$1;
        if (max > len) {
            max = len;
        }
        const blob = blobs.subarray(i, max);
        const blobBuf = DecodeBlob(blob);
        buf = [...buf, ...blobBuf];
    }
    return new Buffer(buf);
}

function computeVersionedHash(commitment, blobCommitmentVersion) {
    const computedVersionedHash = new Uint8Array(32);
    computedVersionedHash.set([blobCommitmentVersion], 0);
    const hash = ethers.ethers.getBytes(ethers.ethers.sha256(commitment));
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

class BlobUploader {
    #kzg;

    #provider;
    #wallet;

    constructor(rpc, pk) {
        this.#provider = new ethers.ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.ethers.Wallet(pk, this.#provider);
    }

    async #getKzg() {
        if (!this.#kzg) {
            this.#kzg = await kzgWasm.loadKZG();
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

    async sendTx(tx, blobs) {
        if (!blobs) {
            return await this.#wallet.sendTransaction(tx);
        }

        if (tx.maxFeePerBlobGas == null) {
            tx.maxFeePerBlobGas = await this.getBlobGasPrice();
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
            versionedHashes.push(ethers.ethers.hexlify(hash));
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
        return ethers.ethers.hexlify(hash);
    }
}

const EthStorageAbi = [
  'function putBlobs(uint256 num) public payable',
  'function putBlob(bytes32 _key, uint256 _blobIdx, uint256 _length) public payable',
  'function get(bytes32 _key, uint8 _decodeType, uint256 _off, uint256 _len) public view returns (bytes memory)',
  'function size(bytes32 _key) public view returns (uint256)',
  'function upfrontPayment() public view returns (uint256)'
];

const SEPOLIA_CHAIN_ID = 11155111;
const QUARKCHAIN_L2_CHAIN_ID = 42069;

const ETHSTORAGE_MAPPING = {
    [SEPOLIA_CHAIN_ID]: '0x804C520d3c084C805E37A35E90057Ac32831F96f',
    [QUARKCHAIN_L2_CHAIN_ID]: '0x90a708C0dca081ca48a9851a8A326775155f87Fd',
};



const BlobTxBytesPerFieldElement         = 32;      // Size in bytes of a field element
const BlobTxFieldElementsPerBlob         = 4096;
const BLOB_SIZE = BlobTxBytesPerFieldElement * BlobTxFieldElementsPerBlob;
const BLOB_DATA_SIZE = 31 * BlobTxFieldElementsPerBlob;
const PaddingPer31Bytes = 1;

class EthStorage {
    #ethStorageRpc;
    #contractAddr;

    #wallet;
    #blobUploader;

    static async create(config) {
        const {rpc, ethStorageRpc, privateKey} = config;
        const chainId = await getChainId(rpc);
        const ethStorageAddress = ETHSTORAGE_MAPPING[chainId];
        if (!ethStorageAddress) {
            throw new Error("EthStorage: Network not supported yet.");
        }

        return new EthStorage({
            rpc,
            ethStorageRpc,
            privateKey,
            ethStorageAddress
        });
    }

    constructor(config) {
        const {rpc, ethStorageRpc, privateKey, ethStorageAddress} = config;
        this.#ethStorageRpc = ethStorageRpc;
        this.#contractAddr = ethStorageAddress;

        const provider = new ethers.ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.ethers.Wallet(privateKey, provider);
        this.#blobUploader = new BlobUploader(rpc, privateKey);
    }

    async estimateCost(key, data) {
        if (!data || !Buffer.isBuffer(data)) {
            throw new Error(`EthStorage: Invalid data.`);
        }
        if (data.length < 0 || data.length > BLOB_DATA_SIZE) {
            throw new Error(`EthStorage: the length of data(Buffer) should be > 0 && < ${BLOB_DATA_SIZE}.`);
        }

        const hexKey = ethers.ethers.keccak256(stringToHex$1(key));
        const contract = new ethers.ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        const [storageCost, maxFeePerBlobGas, gasFeeData] = await Promise.all([
            contract.upfrontPayment(),
            this.#blobUploader.getBlobGasPrice(),
            this.#blobUploader.getGasPrice(),
        ]);

        const blobs = encodeBlobs(data);
        const blobHash = await this.#blobUploader.getBlobHash(blobs[0]);
        const gasLimit = await contract.putBlob.estimateGas(hexKey, 0, data.length, {
            value: storageCost,
            blobVersionedHashes: [blobHash]
        });

        // get cost
        const totalGasCost = (gasFeeData.maxFeePerGas + gasFeeData.maxPriorityFeePerGas) * gasLimit;
        const totalBlobGasCost = maxFeePerBlobGas * BigInt(BLOB_SIZE);
        const gasCost = totalGasCost + totalBlobGasCost;
        return {
            storageCost,
            gasCost
        }
    }

    async write(key, data) {
        if (!data || !Buffer.isBuffer(data)) {
            throw new Error(`EthStorage: Invalid data.`);
        }
        if (data.length < 0 || data.length > BLOB_DATA_SIZE) {
            throw new Error(`EthStorage: the length of data(Buffer) should be > 0 && < ${BLOB_DATA_SIZE}.`);
        }

        const contract = new ethers.ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        const hexKey = ethers.ethers.keccak256(stringToHex$1(key));
        const storageCost = await contract.upfrontPayment();
        const tx = await contract.putBlob.populateTransaction(hexKey, 0, data.length, {
            value: storageCost,
        });

        const blobs = encodeBlobs(data);
        let txRes = await this.#blobUploader.sendTx(tx, blobs);
        console.log(`EthStorage: Send Success! hash is ${txRes.hash}`);
        txRes = await txRes.wait();
        return txRes.status;
    }

    async read(key) {
        if (!key) {
            throw new Error(`EthStorage: Invalid key.`);
        }
        if(!this.#ethStorageRpc) {
            throw new Error(`EthStorage: Reading content requires providing 'ethStorageRpc'.`)
        }
        const hexKey = ethers.ethers.keccak256(stringToHex$1(key));
        const provider = new ethers.ethers.JsonRpcProvider(this.#ethStorageRpc);
        const contract = new ethers.ethers.Contract(this.#contractAddr, EthStorageAbi, provider);
        const size = await contract.size(hexKey, {
            from: this.#wallet.address
        });
        if (size === 0n) {
            throw new Error(`EthStorage: There is no data corresponding to key ${key} under wallet address ${this.#wallet.address}.`)
        }
        const data = await contract.get(hexKey, PaddingPer31Bytes, 0, size, {
            from: this.#wallet.address
        });
        return ethers.ethers.getBytes(data);
    }

    async putBlobs(number, data) {
        if (!data || !Buffer.isBuffer(data)) {
            throw new Error(`EthStorage: Invalid data.`);
        }

        const contract = new ethers.ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        const storageCost = await contract.upfrontPayment();
        const tx = await contract.putBlobs.populateTransaction(number, {
            value: storageCost * BigInt(number),
        });

        const blobs = encodeBlobs(data);
        let txRes = await this.#blobUploader.sendTx(tx, [blobs[0]]);
        console.log(`EthStorage: Send Success! hash is ${txRes.hash}`);
        txRes = await txRes.wait();
        return txRes.status;
    }
}

const contractABI = [
    'function countChunks(bytes memory name) external view returns (uint256)',
    'function readChunk(bytes memory name, uint256 chunkId) external view returns (bytes memory, bool)'
];

const stringToHex = (s) => ethers.ethers.hexlify(ethers.ethers.toUtf8Bytes(s));

async function readChunk(ethStorageRpc, ethStorageAddress, hexName, index) {
    let result;
    try {
        const provider = new ethers.ethers.JsonRpcProvider(ethStorageRpc);
        const contract = new ethers.Contract(ethStorageAddress, contractABI, provider);
        result = await contract.readChunk(hexName, index);
    } catch (e) {
        const provider = new ethers.ethers.JsonRpcProvider(ethStorageRpc);
        const contract = new ethers.Contract(ethStorageAddress, contractABI, provider);
        result = await contract.readChunk(hexName, index);
    }
    return ethers.ethers.getBytes(result[0]);
}

async function Download(ethStorageRpc, ethStorageAddress, fileName) {
    const hexName = stringToHex(fileName);

    const provider = new ethers.ethers.JsonRpcProvider(ethStorageRpc);
    const contract = new ethers.Contract(ethStorageAddress, contractABI, provider);
    const blobCount = await contract.countChunks(hexName);

    let buff = [];
    for (let i = 0; i < blobCount; i++) {
        const chunk = await readChunk(ethStorageRpc, ethStorageAddress, hexName, i);
        buff = [...buff, ...chunk];
    }
    return new Buffer(buff);
}

exports.BlobUploader = BlobUploader;
exports.Download = Download;
exports.EthStorage = EthStorage;
exports.decodeBlob = decodeBlob;
exports.decodeBlobs = decodeBlobs;
exports.encodeBlobs = encodeBlobs;
exports.getChainId = getChainId;
exports.stringToHex = stringToHex$1;
//# sourceMappingURL=index.cjs.js.map
