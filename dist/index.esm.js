import { ethers } from 'ethers';
import { loadKZG } from 'kzg-wasm';

const stringToHex = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));

async function getChainId(rpc) {
    const provider = new ethers.JsonRpcProvider(rpc);
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

    blob = ethers.getBytes(blob);
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

    blobs = ethers.getBytes(blobs);
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

const E_CANCELED = new Error('request for lock canceled');

var __awaiter$2 = function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
class Semaphore {
    constructor(_value, _cancelError = E_CANCELED) {
        this._value = _value;
        this._cancelError = _cancelError;
        this._queue = [];
        this._weightedWaiters = [];
    }
    acquire(weight = 1, priority = 0) {
        if (weight <= 0)
            throw new Error(`invalid weight ${weight}: must be positive`);
        return new Promise((resolve, reject) => {
            const task = { resolve, reject, weight, priority };
            const i = findIndexFromEnd(this._queue, (other) => priority <= other.priority);
            if (i === -1 && weight <= this._value) {
                // Needs immediate dispatch, skip the queue
                this._dispatchItem(task);
            }
            else {
                this._queue.splice(i + 1, 0, task);
            }
        });
    }
    runExclusive(callback_1) {
        return __awaiter$2(this, arguments, void 0, function* (callback, weight = 1, priority = 0) {
            const [value, release] = yield this.acquire(weight, priority);
            try {
                return yield callback(value);
            }
            finally {
                release();
            }
        });
    }
    waitForUnlock(weight = 1, priority = 0) {
        if (weight <= 0)
            throw new Error(`invalid weight ${weight}: must be positive`);
        if (this._couldLockImmediately(weight, priority)) {
            return Promise.resolve();
        }
        else {
            return new Promise((resolve) => {
                if (!this._weightedWaiters[weight - 1])
                    this._weightedWaiters[weight - 1] = [];
                insertSorted(this._weightedWaiters[weight - 1], { resolve, priority });
            });
        }
    }
    isLocked() {
        return this._value <= 0;
    }
    getValue() {
        return this._value;
    }
    setValue(value) {
        this._value = value;
        this._dispatchQueue();
    }
    release(weight = 1) {
        if (weight <= 0)
            throw new Error(`invalid weight ${weight}: must be positive`);
        this._value += weight;
        this._dispatchQueue();
    }
    cancel() {
        this._queue.forEach((entry) => entry.reject(this._cancelError));
        this._queue = [];
    }
    _dispatchQueue() {
        this._drainUnlockWaiters();
        while (this._queue.length > 0 && this._queue[0].weight <= this._value) {
            this._dispatchItem(this._queue.shift());
            this._drainUnlockWaiters();
        }
    }
    _dispatchItem(item) {
        const previousValue = this._value;
        this._value -= item.weight;
        item.resolve([previousValue, this._newReleaser(item.weight)]);
    }
    _newReleaser(weight) {
        let called = false;
        return () => {
            if (called)
                return;
            called = true;
            this.release(weight);
        };
    }
    _drainUnlockWaiters() {
        if (this._queue.length === 0) {
            for (let weight = this._value; weight > 0; weight--) {
                const waiters = this._weightedWaiters[weight - 1];
                if (!waiters)
                    continue;
                waiters.forEach((waiter) => waiter.resolve());
                this._weightedWaiters[weight - 1] = [];
            }
        }
        else {
            const queuedPriority = this._queue[0].priority;
            for (let weight = this._value; weight > 0; weight--) {
                const waiters = this._weightedWaiters[weight - 1];
                if (!waiters)
                    continue;
                const i = waiters.findIndex((waiter) => waiter.priority <= queuedPriority);
                (i === -1 ? waiters : waiters.splice(0, i))
                    .forEach((waiter => waiter.resolve()));
            }
        }
    }
    _couldLockImmediately(weight, priority) {
        return (this._queue.length === 0 || this._queue[0].priority < priority) &&
            weight <= this._value;
    }
}
function insertSorted(a, v) {
    const i = findIndexFromEnd(a, (other) => v.priority <= other.priority);
    a.splice(i + 1, 0, v);
}
function findIndexFromEnd(a, predicate) {
    for (let i = a.length - 1; i >= 0; i--) {
        if (predicate(a[i])) {
            return i;
        }
    }
    return -1;
}

var __awaiter$1 = function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
class Mutex {
    constructor(cancelError) {
        this._semaphore = new Semaphore(1, cancelError);
    }
    acquire() {
        return __awaiter$1(this, arguments, void 0, function* (priority = 0) {
            const [, releaser] = yield this._semaphore.acquire(1, priority);
            return releaser;
        });
    }
    runExclusive(callback, priority = 0) {
        return this._semaphore.runExclusive(() => callback(), 1, priority);
    }
    isLocked() {
        return this._semaphore.isLocked();
    }
    waitForUnlock(priority = 0) {
        return this._semaphore.waitForUnlock(1, priority);
    }
    release() {
        if (this._semaphore.isLocked())
            this._semaphore.release();
    }
    cancel() {
        return this._semaphore.cancel();
    }
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
    #mutex;

    constructor(rpc, pk) {
        this.#provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(pk, this.#provider);
        this.#mutex = new Mutex();
    }

    async #getKzg() {
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
            versionedHashes.push(ethers.hexlify(hash));
        }

        // send
        tx.type = 3;
        tx.blobVersionedHashes = versionedHashes;
        tx.blobs = ethersBlobs;
        tx.kzg = kzg;
        return await this.#wallet.sendTransaction(tx);
    }

    async sendTxLock(tx, blobs) {
        const release = await this.#mutex.acquire();
        try {
            return await this.sendTx(tx, blobs);
        } finally {
            release();
        }
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

var index = /*#__PURE__*/Object.freeze({
    __proto__: null,
    BlobUploader: BlobUploader,
    decodeBlob: decodeBlob,
    decodeBlobs: decodeBlobs,
    encodeBlobs: encodeBlobs,
    getChainId: getChainId,
    stringToHex: stringToHex
});

const EthStorageAbi = [
  'function putBlobs(uint256 num) public payable',
  'function putBlob(bytes32 _key, uint256 _blobIdx, uint256 _length) public payable',
  'function get(bytes32 _key, uint8 _decodeType, uint256 _off, uint256 _len) public view returns (bytes memory)',
  'function size(bytes32 _key) public view returns (uint256)',
  'function upfrontPayment() public view returns (uint256)'
];

const FlatDirectoryAbi = [
  "constructor(uint8 slotLimit, uint32 maxChunkSize, address storageAddress) public",
  "function setDefault(bytes memory _defaultFile) public",
  "function upfrontPayment() external view returns (uint256)",
  "function getChunkHash(bytes memory name, uint256 chunkId) public view returns (bytes32)",
  "function writeChunks(bytes memory name, uint256[] memory chunkIds, uint256[] memory sizes) external payable",
  "function refund() public",
  "function remove(bytes memory name) external returns (uint256)",
  "function countChunks(bytes memory name) external view returns (uint256)",
  "function isSupportBlob() view public returns (bool)",
  "function getStorageMode(bytes memory name) public view returns(uint256)",
  'function readChunk(bytes memory name, uint256 chunkId) external view returns (bytes memory, bool)'
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

// DecodeType
const RawData = 0;
const PaddingPer31Bytes = 1;



const MAX_BLOB_COUNT = 3;

class EthStorage {
    #ethStorageRpc;
    #contractAddr;

    #wallet;
    #blobUploader;

    static async create(config) {
        const {rpc} = config;
        const ethStorage = new EthStorage(config);
        await ethStorage.init(rpc);
        return ethStorage;
    }

    constructor(config) {
        const {rpc, ethStorageRpc, privateKey} = config;
        this.#ethStorageRpc = ethStorageRpc;

        const provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(privateKey, provider);
        this.#blobUploader = new BlobUploader(rpc, privateKey);
    }

    async init(rpc) {
        const chainId = await getChainId(rpc);
        this.#contractAddr = ETHSTORAGE_MAPPING[chainId];
        if (!this.#contractAddr) {
            throw new Error("EthStorage: Network not supported yet.");
        }
    }

    async estimateCost(key, data) {
        if (!data || !Buffer.isBuffer(data)) {
            throw new Error(`EthStorage: Invalid data.`);
        }
        if (data.length < 0 || data.length > BLOB_DATA_SIZE) {
            throw new Error(`EthStorage: the length of data(Buffer) should be > 0 && < ${BLOB_DATA_SIZE}.`);
        }

        const hexKey = ethers.keccak256(stringToHex(key));
        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
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

        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        const hexKey = ethers.keccak256(stringToHex(key));
        try {
            const storageCost = await contract.upfrontPayment();
            const tx = await contract.putBlob.populateTransaction(hexKey, 0, data.length, {
                value: storageCost,
            });

            const blobs = encodeBlobs(data);
            let txRes = await this.#blobUploader.sendTx(tx, blobs);
            console.log(`EthStorage: Tx hash is ${txRes.hash}`);
            txRes = await txRes.wait();
            return txRes.status;
        } catch (e) {
            console.error(`EthStorage: Write blob failed!`, e.message);
        }
        return false;
    }

    async read(key) {
        if (!key) {
            throw new Error(`EthStorage: Invalid key.`);
        }
        if(!this.#ethStorageRpc) {
            throw new Error(`EthStorage: Reading content requires providing 'ethStorageRpc'.`)
        }
        const hexKey = ethers.keccak256(stringToHex(key));
        const provider = new ethers.JsonRpcProvider(this.#ethStorageRpc);
        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, provider);
        const size = await contract.size(hexKey, {
            from: this.#wallet.address
        });
        if (size === 0n) {
            throw new Error(`EthStorage: There is no data corresponding to key ${key} under wallet address ${this.#wallet.address}.`)
        }
        const data = await contract.get(hexKey, PaddingPer31Bytes, 0, size, {
            from: this.#wallet.address
        });
        return ethers.getBytes(data);
    }

    async putBlobs(number, data) {
        if (!data || !Buffer.isBuffer(data)) {
            throw new Error(`EthStorage: Invalid data.`);
        }

        const contract = new ethers.Contract(this.#contractAddr, EthStorageAbi, this.#wallet);
        try {
            const storageCost = await contract.upfrontPayment();
            const tx = await contract.putBlobs.populateTransaction(number, {
                value: storageCost * BigInt(number),
            });

            const blobs = encodeBlobs(data);
            let txRes = await this.#blobUploader.sendTx(tx, [blobs[0]]);
            console.log(`EthStorage: Tx hash is ${txRes.hash}`);
            txRes = await txRes.wait();
            return txRes.status;
        } catch (e) {
            console.error(`EthStorage: Put blobs failed!`, e.message);
        }
        return false;
    }
}

const REMOVE_FAIL = -1;
const REMOVE_NORMAL = 0;
const REMOVE_SUCCESS = 1;

const VERSION_BLOB = '2';


const defaultCallback = {
    onProgress: () => {
    },
    onFail: () => {
    },
    onSuccess: () => {
    },
};

class FlatDirectory {
    #ethStorageRpc;
    #contractAddr;
    #chainId;
    #isSupportBlob;

    #wallet;
    #blobUploader;

    static async create(config) {
        const {rpc, address} = config;
        const flatDirectory = new FlatDirectory(config);
        await flatDirectory.init(rpc, address);
        return flatDirectory;
    }

    constructor(config) {
        const {rpc, ethStorageRpc, privateKey, address} = config;
        this.#ethStorageRpc = ethStorageRpc;
        this.#contractAddr = address;

        const provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(privateKey, provider);
        this.#blobUploader = new BlobUploader(rpc, privateKey);
    }

    async init(rpc, address) {
        this.#chainId = await getChainId(rpc);
        // checkout support blob
        if (address) {
            const provider = new ethers.JsonRpcProvider(rpc);
            const fileContract = new ethers.Contract(address, FlatDirectoryAbi, provider);
            this.#isSupportBlob = await fileContract.isSupportBlob();
        }
    }

    checkAddress() {
        if (!this.#contractAddr) {
            throw new Error(`FlatDirectory: FlatDirectory not deployed!`);
        }
    }

    async deploy() {
        this.#isSupportBlob = ETHSTORAGE_MAPPING[this.#chainId] != null;
        const ethStorage = ETHSTORAGE_MAPPING[this.#chainId] || '0x0000000000000000000000000000000000000000';
        const contractByteCode = '0x60c0604052600060a09081526006906200001a9082620001ac565b503480156200002857600080fd5b50604051620038d0380380620038d08339810160408190526200004b9162000278565b60ff831660805282828281816200006233620000b5565b6002805463ffffffff909316600160a01b0263ffffffff60a01b1990931692909217909155600380546001600160a01b039092166001600160a01b031990921691909117905550620002e4945050505050565b600280546001600160a01b038381166001600160a01b0319831681179093556040519116919082907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a35050565b634e487b7160e01b600052604160045260246000fd5b600181811c908216806200013257607f821691505b6020821081036200015357634e487b7160e01b600052602260045260246000fd5b50919050565b601f821115620001a757600081815260208120601f850160051c81016020861015620001825750805b601f850160051c820191505b81811015620001a3578281556001016200018e565b5050505b505050565b81516001600160401b03811115620001c857620001c862000107565b620001e081620001d984546200011d565b8462000159565b602080601f831160018114620002185760008415620001ff5750858301515b600019600386901b1c1916600185901b178555620001a3565b600085815260208120601f198616915b82811015620002495788860151825594840194600190910190840162000228565b5085821015620002685787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b6000806000606084860312156200028e57600080fd5b835160ff81168114620002a057600080fd5b602085015190935063ffffffff81168114620002bb57600080fd5b60408501519092506001600160a01b0381168114620002d957600080fd5b809150509250925092565b6080516135c962000307600039600081816105500152611e9301526135c96000f3fe608060405260043610620001ee5760003560e01c8063590e1ae3116200010f578063caf1283611620000a3578063dd473fae116200006d578063dd473fae1462000776578063f14c7ad71462000794578063f2fde38b14620007ac578063f916c5b014620007d157620001ee565b8063caf1283614620006b5578063cf86bf9314620006f0578063d84eb56c146200072c578063dc38b0a2146200075157620001ee565b80638bf4515c11620000e55780638bf4515c14620006005780638da5cb5b146200062557806393b7628f1462000645578063956a3433146200069057620001ee565b8063590e1ae314620005ab5780635ba1d9e514620005c3578063715018a614620005e857620001ee565b80631ccbc6da116200018757806342216bed116200015d57806342216bed1462000504578063492c7b2a14620005295780634eed7cf1146200054057806358edef4c146200058657620001ee565b80631ccbc6da14620004ae5780631fbfa12714620004d55780632b68b9c614620004ec57620001ee565b806311ce026711620001c957806311ce026714620003de5780631a7237e014620004195780631c5ee10c146200044e5780631c993ad5146200048957620001ee565b8063038cd79f14620003705780630936286114620003895780631089f40f14620003b9575b348015620001fb57600080fd5b506000366060808284036200022157505060408051602081019091526000815262000365565b8383600081811062000237576200023762002a5f565b9050013560f81c60f81b6001600160f81b031916602f60f81b146200028357505060408051808201909152600e81526d0d2dcc6dee4e4cac6e840e0c2e8d60931b602082015262000365565b83836200029260018262002a8b565b818110620002a457620002a462002a5f565b909101356001600160f81b031916602f60f81b0390506200030657620002fd620002d2846001818862002aa1565b6006604051602001620002e89392919062002b03565b604051602081830303815290604052620007f6565b50905062000358565b6200035462000319846001818862002aa1565b8080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250620007f692505050565b5090505b6200036381620008a1565b505b915050805190602001f35b620003876200038136600462002ca3565b620008e2565b005b3480156200039657600080fd5b50620003a16200092c565b604051620003b0919062002d66565b60405180910390f35b348015620003c657600080fd5b5062000387620003d836600462002d7b565b620009c2565b348015620003eb57600080fd5b5060035462000400906001600160a01b031681565b6040516001600160a01b039091168152602001620003b0565b3480156200042657600080fd5b506200043e6200043836600462002da3565b62000a15565b604051620003b092919062002deb565b3480156200045b57600080fd5b50620004736200046d36600462002e11565b62000ac5565b60408051928352602083019190915201620003b0565b3480156200049657600080fd5b5062000387620004a836600462002e11565b62000b58565b348015620004bb57600080fd5b50620004c662000b97565b604051908152602001620003b0565b62000387620004e636600462002ed9565b62000c0d565b348015620004f957600080fd5b506200038762000d92565b3480156200051157600080fd5b50620004c66200052336600462002da3565b62000dcd565b620003876200053a36600462002f6a565b62000e78565b3480156200054d57600080fd5b507f000000000000000000000000000000000000000000000000000000000000000060ff1615155b6040519015158152602001620003b0565b3480156200059357600080fd5b50620004c6620005a536600462002e11565b62000f8f565b348015620005b857600080fd5b506200038762001057565b348015620005d057600080fd5b5062000575620005e236600462002da3565b620010c1565b348015620005f557600080fd5b506200038762001181565b3480156200060d57600080fd5b506200043e6200061f36600462002e11565b620007f6565b3480156200063257600080fd5b506002546001600160a01b031662000400565b3480156200065257600080fd5b50620006816200066436600462002e11565b805160209182012060009081526005909152604090205460ff1690565b604051620003b0919062002ff6565b3480156200069d57600080fd5b50620004c6620006af36600462003013565b620011bc565b348015620006c257600080fd5b50620006da620006d436600462002da3565b62001276565b60408051928352901515602083015201620003b0565b348015620006fd57600080fd5b506002546200071690600160a01b900463ffffffff1681565b60405163ffffffff9091168152602001620003b0565b3480156200073957600080fd5b50620004c66200074b36600462002da3565b6200130c565b3480156200075e57600080fd5b50620003876200077036600462003036565b620013c2565b3480156200078357600080fd5b50651b585b9d585b60d21b620004c6565b348015620007a157600080fd5b506200057562001411565b348015620007b957600080fd5b5062000387620007cb36600462003036565b6200143d565b348015620007de57600080fd5b50620004c6620007f036600462002e11565b620014dc565b60606000806200081d84805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000836576200083662002fe0565b0362000858576200084e848051906020012062001561565b9250925050915091565b60018160028111156200086f576200086f62002fe0565b0362000887576200084e848051906020012062001761565b505060408051600080825260208201909252939092509050565b600081516040620008b3919062003061565b9050601f19620008c582602062003061565b620008d290601f62003061565b1690506020808303528060208303f35b6002546001600160a01b03163314620009185760405162461bcd60e51b81526004016200090f9062003077565b60405180910390fd5b62000927836000848462000e78565b505050565b600680546200093b9062002acd565b80601f0160208091040260200160405190810160405280929190818152602001828054620009699062002acd565b8015620009ba5780601f106200098e57610100808354040283529160200191620009ba565b820191906000526020600020905b8154815290600101906020018083116200099c57829003601f168201915b505050505081565b6002546001600160a01b03163314620009ef5760405162461bcd60e51b81526004016200090f9062003077565b6002805463ffffffff909216600160a01b0263ffffffff60a01b19909216919091179055565b606060008062000a3c85805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000a555762000a5562002fe0565b0362000a795762000a6e8580519060200120856200188e565b925092505062000abe565b600181600281111562000a905762000a9062002fe0565b0362000aa95762000a6e8580519060200120856200196b565b50506040805160008082526020820190925291505b9250929050565b600080600062000aec84805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000b055762000b0562002fe0565b0362000b1d576200084e8480519060200120620019e4565b600181600281111562000b345762000b3462002fe0565b0362000b4c576200084e848051906020012062001abb565b50600093849350915050565b6002546001600160a01b0316331462000b855760405162461bcd60e51b81526004016200090f9062003077565b600662000b938282620030f6565b5050565b60035460408051630e65e36d60e11b815290516000926001600160a01b031691631ccbc6da9160048083019260209291908290030181865afa15801562000be2573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062000c089190620031c2565b905090565b6002546001600160a01b0316331462000c3a5760405162461bcd60e51b81526004016200090f9062003077565b62000c4462001411565b62000cab5760405162461bcd60e51b815260206004820152603060248201527f5468652063757272656e74206e6574776f726b20646f6573206e6f742073757060448201526f1c1bdc9d08189b1bd8881d5c1b1bd85960821b60648201526084016200090f565b600062000ccf84805160209182012060009081526005909152604090205460ff1690565b9050600081600281111562000ce85762000ce862002fe0565b148062000d095750600281600281111562000d075762000d0762002fe0565b145b62000d4e5760405162461bcd60e51b8152602060048201526014602482015273496e76616c69642073746f72616765206d6f646560601b60448201526064016200090f565b600081600281111562000d655762000d6562002fe0565b0362000d785762000d7884600262001b12565b62000d8c8480519060200120848462001b54565b50505050565b6002546001600160a01b0316331462000dbf5760405162461bcd60e51b81526004016200090f9062003077565b6002546001600160a01b0316ff5b60008062000df284805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000e0b5762000e0b62002fe0565b0362000e2d5762000e24848051906020012084620011bc565b91505062000e72565b600181600281111562000e445762000e4462002fe0565b0362000e6c57600062000e58858562000a15565b508051602090910120925062000e72915050565b50600090505b92915050565b6002546001600160a01b0316331462000ea55760405162461bcd60e51b81526004016200090f9062003077565b600062000ec985805160209182012060009081526005909152604090205460ff1690565b9050600081600281111562000ee25762000ee262002fe0565b148062000f035750600181600281111562000f015762000f0162002fe0565b145b62000f485760405162461bcd60e51b8152602060048201526014602482015273496e76616c69642073746f72616765206d6f646560601b60448201526064016200090f565b600081600281111562000f5f5762000f5f62002fe0565b0362000f725762000f7285600162001b12565b62000f8885805190602001208585853462001e83565b5050505050565b6002546000906001600160a01b0316331462000fbf5760405162461bcd60e51b81526004016200090f9062003077565b600062000fe383805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000ffc5762000ffc62002fe0565b036200101d57620010168380519060200120600062001f6c565b9392505050565b600181600281111562001034576200103462002fe0565b036200104e57620010168380519060200120600062001fcc565b50600092915050565b6002546001600160a01b03163314620010845760405162461bcd60e51b81526004016200090f9062003077565b6002546040516001600160a01b03909116904780156108fc02916000818181858888f19350505050158015620010be573d6000803e3d6000fd5b50565b6002546000906001600160a01b03163314620010f15760405162461bcd60e51b81526004016200090f9062003077565b60006200111584805160209182012060009081526005909152604090205460ff1690565b905060028160028111156200112e576200112e62002fe0565b03620011475762000e248480519060200120846200208e565b60018160028111156200115e576200115e62002fe0565b03620011775762000e2484805190602001208462002116565b5060009392505050565b6002546001600160a01b03163314620011ae5760405162461bcd60e51b81526004016200090f9062003077565b620011ba600062002206565b565b6000620011c98362002258565b8210620011d95750600062000e72565b60035460008481526004602081815260408084208785529091529182902054915163d8389dc560e01b8152908101919091526001600160a01b039091169063d8389dc590602401602060405180830381865afa1580156200123e573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190620012649190620031dc565b67ffffffffffffffff19169392505050565b60008060006200129d85805160209182012060009081526005909152604090205460ff1690565b90506002816002811115620012b657620012b662002fe0565b03620012cf5762000a6e85805190602001208562002299565b6001816002811115620012e657620012e662002fe0565b03620012ff5762000a6e8580519060200120856200234d565b5060009485945092505050565b6002546000906001600160a01b031633146200133c5760405162461bcd60e51b81526004016200090f9062003077565b60006200136084805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562001379576200137962002fe0565b03620013925762000e2484805190602001208462001f6c565b6001816002811115620013a957620013a962002fe0565b03620011775762000e2484805190602001208462001fcc565b6002546001600160a01b03163314620013ef5760405162461bcd60e51b81526004016200090f9062003077565b600380546001600160a01b0319166001600160a01b0392909216919091179055565b6003546000906001600160a01b03161580159062000c08575060006200143662000b97565b1015905090565b6002546001600160a01b031633146200146a5760405162461bcd60e51b81526004016200090f9062003077565b6001600160a01b038116620014d15760405162461bcd60e51b815260206004820152602660248201527f4f776e61626c653a206e6577206f776e657220697320746865207a65726f206160448201526564647265737360d01b60648201526084016200090f565b620010be8162002206565b6000806200150183805160209182012060009081526005909152604090205460ff1690565b905060028160028111156200151a576200151a62002fe0565b03620015325762001016838051906020012062002258565b600181600281111562001549576200154962002fe0565b036200104e57620010168380519060200120620023a5565b606060008060006200157385620019e4565b9150915080600003620015bb5760005b6040519080825280601f01601f191660200182016040528015620015ae576020820181803683370190505b5095600095509350505050565b6000826001600160401b03811115620015d857620015d862002b90565b6040519080825280601f01601f19166020018201604052801562001603576020820181803683370190505b5090506000805b838110156200175257600088815260046020818152604080842085855290915280832054600354915163afd5644d60e01b815292830181905292916001600160a01b039091169063afd5644d90602401602060405180830381865afa15801562001678573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906200169e9190620031c2565b60035460405163bea94b8b60e01b81529192506001600160a01b03169063bea94b8b90620016d9908590600190600090879060040162003209565b600060405180830381865afa158015620016f7573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f191682016040526200172191908101906200323e565b508060406020868801013e62001738818562003061565b9350505080806200174990620032bd565b9150506200160a565b50909660019650945050505050565b60606000806000620017738562001abb565b91509150806000036200178857600062001583565b6000826001600160401b03811115620017a557620017a562002b90565b6040519080825280601f01601f191660200182016040528015620017d0576020820181803683370190505b5090506020810160005b838110156200175257600088815260208181526040808320848452909152812054906200180782620023e4565b156200184957620018188260e01c90565b60008b8152600160209081526040808320878452909152902090915062001841908386620023f9565b505062001868565b816200185581620024ad565b50915062001864818662002513565b5050505b62001874818562003061565b9350505080806200188590620032bd565b915050620017da565b60606000806200189f858562002299565b5090506001811015620018c657505060408051600080825260208201909252915062000abe565b600354600086815260046020818152604080842089855290915280832054905163bea94b8b60e01b815292936001600160a01b03169263bea94b8b92620019169291600191879189910162003209565b600060405180830381865afa15801562001934573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f191682016040526200195e91908101906200323e565b9660019650945050505050565b600082815260208181526040808320848452909152812054606091906200199281620023e4565b15620019cc5760008581526001602090815260408083208784529091528120620019bd908362002572565b93506001925062000abe915050565b80620019d88162002619565b93509350505062000abe565b6000806000620019f48462002258565b90506000805b8281101562001ab15760035460008781526004602081815260408084208685529091529182902054915163afd5644d60e01b8152908101919091526001600160a01b039091169063afd5644d90602401602060405180830381865afa15801562001a68573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062001a8e9190620031c2565b62001a9a908362003061565b91508062001aa881620032bd565b915050620019fa565b5094909350915050565b6000806000805b60008062001ad187846200234d565b915091508062001ae357505062001b08565b62001aef828562003061565b93508262001afd81620032bd565b935050505062001ac2565b9094909350915050565b81516020808401919091206000908152600590915260409020805482919060ff1916600183600281111562001b4b5762001b4b62002fe0565b02179055505050565b815160035460408051630e65e36d60e11b815290516000926001600160a01b031691631ccbc6da9160048083019260209291908290030181865afa15801562001ba1573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062001bc79190620031c2565b905062001bd58282620032d9565b34101562001c1d5760405162461bcd60e51b8152602060048201526014602482015273696e73756666696369656e742062616c616e636560601b60448201526064016200090f565b60005b828160ff16101562001e7b57838160ff168151811062001c445762001c4462002a5f565b6020026020010151600010801562001c935750600260149054906101000a900463ffffffff1663ffffffff16848260ff168151811062001c885762001c8862002a5f565b602002602001015111155b62001cd85760405162461bcd60e51b81526020600482015260146024820152730d2dcecc2d8d2c840c6d0eadcd640d8cadccee8d60631b60448201526064016200090f565b62001d0386868360ff168151811062001cf55762001cf562002a5f565b6020026020010151620026bf565b60003387878460ff168151811062001d1f5762001d1f62002a5f565b602002602001015160405160200162001d56939291906001600160a01b039390931683526020830191909152604082015260600190565b604051602081830303815290604052805190602001209050600360009054906101000a90046001600160a01b03166001600160a01b0316634581a920848385898760ff168151811062001dad5762001dad62002a5f565b60200260200101516040518563ffffffff1660e01b815260040162001de89392919092835260ff919091166020830152604082015260600190565b6000604051808303818588803b15801562001e0257600080fd5b505af115801562001e17573d6000803e3d6000fd5b505050505080600460008981526020019081526020016000206000888560ff168151811062001e4a5762001e4a62002a5f565b602002602001015181526020019081526020016000208190555050808062001e7290620032f3565b91505062001c20565b505050505050565b62001e8f85856200275d565b60ff7f00000000000000000000000000000000000000000000000000000000000000001682111562001ef65762001ed862001ecc84848462002875565b6001600160a01b031690565b60008681526020818152604080832088845290915290205562000f88565b60008581526001602090815260408083208784528252918290208251601f860183900483028101830190935284835262001f4d92909186908690819084018382808284376000920191909152506200293192505050565b6000868152602081815260408083208884529091529020555050505050565b60005b60008381526004602090815260408083208584529091529020548062001f96575062001fc6565b60008481526004602090815260408083208684529091528120558262001fbc81620032bd565b9350505062001f6f565b50919050565b60005b6000838152602081815260408083208584529091529020548062001ff4575062001fc6565b62001fff81620023e4565b62002060576000819050806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b1580156200204557600080fd5b505af11580156200205a573d6000803e3d6000fd5b50505050505b600084815260208181526040808320868452909152812055826200208481620032bd565b9350505062001fcf565b600082815260046020908152604080832084845290915281205480620020b957600091505062000e72565b600084815260046020526040812081620020d586600162003061565b81526020019081526020016000205414620020f557600091505062000e72565b50506000918252600460209081526040808420928452919052812055600190565b600082815260208181526040808320848452909152812054806200213f57600091505062000e72565b6000848152602081905260408120816200215b86600162003061565b815260200190815260200160002054146200217b57600091505062000e72565b6200218681620023e4565b620021e7576000819050806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b158015620021cc57600080fd5b505af1158015620021e1573d6000803e3d6000fd5b50505050505b5050600091825260208281526040808420928452919052812055600190565b600280546001600160a01b038381166001600160a01b0319831681179093556040519116919082907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a35050565b6000805b60008381526004602090815260408083208484529091529020548062002283575062000e72565b816200228f81620032bd565b925050506200225c565b600080620022a78462002258565b8310620022ba5750600090508062000abe565b600354600085815260046020818152604080842088855290915280832054905163afd5644d60e01b81529182015290916001600160a01b03169063afd5644d90602401602060405180830381865afa1580156200231b573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190620023419190620031c2565b95600195509350505050565b6000828152602081815260408083208484529091528120548190806200237b57600080925092505062000abe565b6200238681620023e4565b1562002399576000620019bd8260e01c90565b80620019d881620024ad565b6000805b60008381526020818152604080832084845290915290205480620023ce575062000e72565b81620023da81620032bd565b92505050620023a9565b600080620023f28360e01c90565b1192915050565b60008060006200240985620029cb565b808652909350905083601c8411156200249f57601c81016000805b6020600162002435601c8a62002a8b565b6200244290602062003061565b6200244e919062002a8b565b6200245a919062003315565b8110156200249b57600081815260208b815260409091205480855292506200248490849062003061565b9250806200249281620032bd565b91505062002424565b5050505b600192505050935093915050565b6000806001600160a01b038316620024ca57506000928392509050565b60008060405180610160016040528061012681526020016200346e6101269139519050843b91508082101562002507575060009485945092505050565b62002341818362002a8b565b6000806000806200252486620024ad565b91509150806200253d5760008093509350505062000abe565b600060405180610160016040528061012681526020016200346e6101269139519050828187893c509095600195509350505050565b606060006200258183620029e6565b92509050601c8111156200261257603c82016000805b60206001620025a8601c8762002a8b565b620025b590602062003061565b620025c1919062002a8b565b620025cd919062003315565b8110156200260e57600081815260208881526040909120548085529250620025f790849062003061565b9250806200260581620032bd565b91505062002597565b5050505b5092915050565b606060008060006200262b85620024ad565b91509150806200263d57600062001583565b6000826001600160401b038111156200265a576200265a62002b90565b6040519080825280601f01601f19166020018201604052801562002685576020820181803683370190505b509050600060405180610160016040528061012681526020016200346e6101269139519050838160208401893c5095600195509350505050565b60008281526004602090815260408083208484529091529020548062000927578115806200271657506000838152600460205260408120816200270460018662002a8b565b81526020019081526020016000205414155b620009275760405162461bcd60e51b81526020600482015260166024820152751b5d5cdd081c995c1b1858d9481bdc88185c1c195b9960521b60448201526064016200090f565b60008281526020818152604080832084845290915290205480620027f957811580620027b25750600083815260208190526040812081620027a060018662002a8b565b81526020019081526020016000205414155b620027f95760405162461bcd60e51b81526020600482015260166024820152751b5d5cdd081c995c1b1858d9481bdc88185c1c195b9960521b60448201526064016200090f565b6200280481620023e4565b6200092757806001600160a01b0381161562000d8c57806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b1580156200285657600080fd5b505af11580156200286b573d6000803e3d6000fd5b5050505050505050565b60008060405180610160016040528061012681526020016200346e61012691398585604051602001620028ab9392919062003338565b60408051601f1981840301815291905290506000620028cd6043602062003061565b30838201529050620028e2608c602062003061565b905030818301525060008382604051620028fc9062002a51565b62002908919062002d66565b6040518091039082f090508015801562002926573d6000803e3d6000fd5b509695505050505050565b805160208083015160e083901b911c1790601c81111562002612576000603c8401815b6020600162002965601c8762002a8b565b6200297290602062003061565b6200297e919062002a8b565b6200298a919062003315565b8110156200260e5781519250620029a382602062003061565b6000828152602089905260409020849055915080620029c281620032bd565b91505062002954565b600080620029d98360e01c90565b9360209390931b92915050565b60006060620029f58360e01c90565b9150602083901b9250816001600160401b0381111562002a195762002a1962002b90565b6040519080825280601f01601f19166020018201604052801562002a44576020820181803683370190505b5060208101939093525091565b61010b806200336383390190565b634e487b7160e01b600052603260045260246000fd5b634e487b7160e01b600052601160045260246000fd5b8181038181111562000e725762000e7262002a75565b6000808585111562002ab257600080fd5b8386111562002ac057600080fd5b5050820193919092039150565b600181811c9082168062002ae257607f821691505b60208210810362001fc657634e487b7160e01b600052602260045260246000fd5b828482376000838201600081526000845462002b1f8162002acd565b6001828116801562002b3a576001811462002b505762002b81565b60ff198416865282151583028601945062002b81565b8860005260208060002060005b8581101562002b785781548982015290840190820162002b5d565b50505082860194505b50929998505050505050505050565b634e487b7160e01b600052604160045260246000fd5b604051601f8201601f191681016001600160401b038111828210171562002bd15762002bd162002b90565b604052919050565b60006001600160401b0382111562002bf55762002bf562002b90565b50601f01601f191660200190565b600082601f83011262002c1557600080fd5b813562002c2c62002c268262002bd9565b62002ba6565b81815284602083860101111562002c4257600080fd5b816020850160208301376000918101602001919091529392505050565b60008083601f84011262002c7257600080fd5b5081356001600160401b0381111562002c8a57600080fd5b60208301915083602082850101111562000abe57600080fd5b60008060006040848603121562002cb957600080fd5b83356001600160401b038082111562002cd157600080fd5b62002cdf8783880162002c03565b9450602086013591508082111562002cf657600080fd5b5062002d058682870162002c5f565b9497909650939450505050565b60005b8381101562002d2f57818101518382015260200162002d15565b50506000910152565b6000815180845262002d5281602086016020860162002d12565b601f01601f19169290920160200192915050565b60208152600062001016602083018462002d38565b60006020828403121562002d8e57600080fd5b813563ffffffff811681146200101657600080fd5b6000806040838503121562002db757600080fd5b82356001600160401b0381111562002dce57600080fd5b62002ddc8582860162002c03565b95602094909401359450505050565b60408152600062002e00604083018562002d38565b905082151560208301529392505050565b60006020828403121562002e2457600080fd5b81356001600160401b0381111562002e3b57600080fd5b62002e498482850162002c03565b949350505050565b600082601f83011262002e6357600080fd5b813560206001600160401b0382111562002e815762002e8162002b90565b8160051b62002e9282820162002ba6565b928352848101820192828101908785111562002ead57600080fd5b83870192505b8483101562002ece5782358252918301919083019062002eb3565b979650505050505050565b60008060006060848603121562002eef57600080fd5b83356001600160401b038082111562002f0757600080fd5b62002f158783880162002c03565b9450602086013591508082111562002f2c57600080fd5b62002f3a8783880162002e51565b9350604086013591508082111562002f5157600080fd5b5062002f608682870162002e51565b9150509250925092565b6000806000806060858703121562002f8157600080fd5b84356001600160401b038082111562002f9957600080fd5b62002fa78883890162002c03565b955060208701359450604087013591508082111562002fc557600080fd5b5062002fd48782880162002c5f565b95989497509550505050565b634e487b7160e01b600052602160045260246000fd5b60208101600383106200300d576200300d62002fe0565b91905290565b600080604083850312156200302757600080fd5b50508035926020909101359150565b6000602082840312156200304957600080fd5b81356001600160a01b03811681146200101657600080fd5b8082018082111562000e725762000e7262002a75565b6020808252818101527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604082015260600190565b601f8211156200092757600081815260208120601f850160051c81016020861015620030d55750805b601f850160051c820191505b8181101562001e7b57828155600101620030e1565b81516001600160401b0381111562003112576200311262002b90565b6200312a8162003123845462002acd565b84620030ac565b602080601f831160018114620031625760008415620031495750858301515b600019600386901b1c1916600185901b17855562001e7b565b600085815260208120601f198616915b82811015620031935788860151825594840194600190910190840162003172565b5085821015620031b25787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b600060208284031215620031d557600080fd5b5051919050565b600060208284031215620031ef57600080fd5b815167ffffffffffffffff19811681146200101657600080fd5b848152608081016002851062003223576200322362002fe0565b84602083015283604083015282606083015295945050505050565b6000602082840312156200325157600080fd5b81516001600160401b038111156200326857600080fd5b8201601f810184136200327a57600080fd5b80516200328b62002c268262002bd9565b818152856020838501011115620032a157600080fd5b620032b482602083016020860162002d12565b95945050505050565b600060018201620032d257620032d262002a75565b5060010190565b808202811582820484141762000e725762000e7262002a75565b600060ff821660ff81036200330c576200330c62002a75565b60010192915050565b6000826200333357634e487b7160e01b600052601260045260246000fd5b500490565b600084516200334c81846020890162002d12565b820183858237600093019283525090939250505056fe608060405260405161010b38038061010b83398101604081905261002291610041565b80518060208301f35b634e487b7160e01b600052604160045260246000fd5b6000602080838503121561005457600080fd5b82516001600160401b038082111561006b57600080fd5b818501915085601f83011261007f57600080fd5b8151818111156100915761009161002b565b604051601f8201601f19908116603f011681019083821181831017156100b9576100b961002b565b8160405282815288868487010111156100d157600080fd5b600093505b828410156100f357848401860151818501870152928501926100d6565b60008684830101528096505050505050509291505056fe6080604052348015600f57600080fd5b506004361060325760003560e01c80632b68b9c61460375780638da5cb5b14603f575b600080fd5b603d6081565b005b60657f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b03909116815260200160405180910390f35b336001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000161460ed5760405162461bcd60e51b815260206004820152600e60248201526d3737ba10333937b69037bbb732b960911b604482015260640160405180910390fd5b33fffea2646970667358221220fc66c9afb7cb2f6209ae28167cf26c6c06f86a82cbe3c56de99027979389a1be64736f6c63430008070033a264697066735822122074ecdb7c1356cd26b7ae20a002751e685b2c97645c0ec1b1214c316ec9516dce64736f6c63430008120033';
        const factory = new ethers.ContractFactory(FlatDirectoryAbi, contractByteCode, this.#wallet);
        try {
            const contract = await factory.deploy(0, BLOB_DATA_SIZE, ethStorage, {gasLimit: 3800000});
            await contract.waitForDeployment();

            this.#contractAddr = await contract.getAddress();
            console.log(`FlatDirectory: Address is ${this.#contractAddr}`);
            return this.#contractAddr;
        } catch (e) {
            console.error(`FlatDirectory: Deploy FlatDirectory failed!`, e.message);
            return null;
        }
    }

    async setDefault(filename) {
        this.checkAddress();

        const hexName = filename ? stringToHex(filename) : "0x";
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        try {
            const tx = await fileContract.setDefault(hexName);
            console.log(`FlatDirectory: Tx hash is ${tx.hash}`);
            const txReceipt = await tx.wait();
            return txReceipt.status;
        } catch (e) {
            console.error(`FlatDirectory: Set default file failed!`, e.message);
        }
        return false;
    }

    async refund() {
        this.checkAddress();

        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        try {
            const tx = await fileContract.refund();
            console.log(`FlatDirectory: Tx hash is ${tx.hash}`);
            const txReceipt = await tx.wait();
            return txReceipt.status;
        } catch (e) {
            console.error(`FlatDirectory: Refund failed!`, e.message);
        }
        return false;
    }

    async remove(key) {
        this.checkAddress();

        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        try {
            const tx = await fileContract.remove(stringToHex(key));
            console.log(`FlatDirectory: tx hash is ${tx.hash}`);
            const receipt = await tx.wait();
            return receipt.status;
        } catch (e) {
            console.error(`FlatDirectory: Failed to remove file: ${key}`, e.message);
        }
        return false;
    }

    async download(key) {
        this.checkAddress();
        if (!this.#ethStorageRpc) {
            throw new Error(`FlatDirectory: Reading content requires providing 'ethStorageRpc'.`);
        }

        let buff = [];
        const hexName = stringToHex(key);
        const provider = new ethers.JsonRpcProvider(this.#ethStorageRpc);
        const contract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, provider);
        try {
            const blobCount = await contract.countChunks(hexName);
            for (let i = 0; i < blobCount; i++) {
                const result = await contract.readChunk(hexName, i);
                const chunk = ethers.getBytes(result[0]);
                buff = [...buff, ...chunk];
            }
        } catch (e) {
            console.error(`FlatDirectory: Download failed!`, e.message);
        }
        return Buffer.from(buff);
    }

    downloadSync(key, cb = defaultCallback) {
        this.checkAddress();
        if (!this.#ethStorageRpc) {
            throw new Error(`FlatDirectory: Reading content requires providing 'ethStorageRpc'.`);
        }

        const hexName = stringToHex(key);
        const provider = new ethers.JsonRpcProvider(this.#ethStorageRpc);
        const contract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, provider);
        try {
            contract.countChunks(hexName).then(async (blobCount) => {
                let buff = [];
                for (let i = 0; i < blobCount; i++) {
                    let result;
                    try {
                        result = await contract.readChunk(hexName, i);
                    } catch (e) {
                        cb.onFail(e);
                        return;
                    }
                    const chunk = ethers.getBytes(result[0]);
                    cb.onProgress(i, blobCount, Buffer.from(chunk));
                    buff = [...buff, ...chunk];
                }
                cb.onSuccess(Buffer.from(buff));
            });
        } catch (err) {
            cb.onFail(err);
        }
    }

    async estimateCost(key, data) {
        this.checkAddress();
        if (!this.#isSupportBlob) {
            throw new Error(`FlatDirectory: The contract does not support blob upload!`);
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const fileMod = await fileContract.getStorageMode(hexName);
        if (fileMod !== BigInt(VERSION_BLOB) && fileMod !== 0n) {
            throw new Error(`FlatDirectory: This file does not support blob upload!`);
        }

        const content = Buffer.from(data);
        const blobs = encodeBlobs(content);
        const blobLength = blobs.length;
        const blobDataSize = BLOB_DATA_SIZE;

        let totalGasCost = 0n;
        let totalStorageCost = 0n;
        let gasLimit = 0;
        const [cost, maxFeePerBlobGas, gasFeeData] = await Promise.all([
            fileContract.upfrontPayment(),
            this.#blobUploader.getBlobGasPrice(),
            this.#blobUploader.getGasPrice(),
        ]);
        // send
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const blobArr = [];
            const chunkIdArr = [];
            const chunkSizeArr = [];
            const blobHashArr = [];
            const blobHashRequestArr = [];
            let max = i + MAX_BLOB_COUNT > blobLength ? blobLength : i + MAX_BLOB_COUNT;
            for (let j = i; j < max; j++) {
                blobArr.push(blobs[j]);
                chunkIdArr.push(j);
                chunkSizeArr.push(blobDataSize);

                blobHashArr.push(await this.#blobUploader.getBlobHash(blobs[j]));
                blobHashRequestArr.push(fileContract.getChunkHash(hexName, j));
            }

            // check change
            const isChange = await this.#checkChange(fileContract, blobHashArr, blobHashRequestArr);
            if (!isChange) {
                continue;
            }

            // upload
            // storage cost
            const value = cost * BigInt(blobArr.length);
            totalStorageCost += value;
            // gas cost
            if (gasLimit === 0) {
                gasLimit = await fileContract.writeChunks.estimateGas(hexName, chunkIdArr, chunkSizeArr, {
                    value: value,
                    blobVersionedHashes: blobHashArr
                });
            }
            const gasCost = (gasFeeData.maxFeePerGas + gasFeeData.maxPriorityFeePerGas) * gasLimit;
            const blobGasCost = maxFeePerBlobGas * BigInt(BLOB_SIZE);
            totalGasCost += gasCost + blobGasCost;
        }

        return {
            storageCost: totalStorageCost,
            gasCost: totalGasCost
        }
    }

    // ******upload data******* /
    async upload(key, data, cb = defaultCallback) {
        this.checkAddress();
        if (!this.#isSupportBlob) {
            cb.onFail(new Error(`FlatDirectory: The contract does not support blob upload!`));
            return;
        }

        const hexName = stringToHex(key);
        const fileContract = new ethers.Contract(this.#contractAddr, FlatDirectoryAbi, this.#wallet);
        const fileMod = await fileContract.getStorageMode(hexName);
        if (fileMod !== BigInt(VERSION_BLOB) && fileMod !== 0n) {
            cb.onFail(new Error(`FlatDirectory: This file does not support blob upload!`));
            return;
        }

        const content = Buffer.from(data);
        const blobs = encodeBlobs(content);
        const blobLength = blobs.length;
        const blobDataSize = BLOB_DATA_SIZE;
        const fileSize = content.length;
        // check old data
        const [cost, oldChunkLength] = await Promise.all([
            fileContract.upfrontPayment(),
            fileContract.countChunks(hexName),
        ]);

        const clearState = await this.#clearOldFile(hexName, blobLength, oldChunkLength);
        if (clearState === REMOVE_FAIL) {
            cb.onFail(new Error(`FlatDirectory: Failed to delete old data!`));
            return;
        }

        // send
        let totalUploadCount = 0;
        let totalUploadSize = 0;
        let totalCost = 0n;
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const blobArr = [];
            const chunkIdArr = [];
            const chunkSizeArr = [];
            const blobHashArr = [];
            const blobHashRequestArr = [];
            let max = i + MAX_BLOB_COUNT > blobLength ? blobLength : i + MAX_BLOB_COUNT;
            for (let j = i; j < max; j++) {
                blobArr.push(blobs[j]);
                chunkIdArr.push(j);
                if (j === blobLength - 1) {
                    chunkSizeArr.push(fileSize - blobDataSize * (blobLength - 1));
                } else {
                    chunkSizeArr.push(blobDataSize);
                }
                blobHashArr.push(await this.#blobUploader.getBlobHash(blobs[j]));
                blobHashRequestArr.push(fileContract.getChunkHash(hexName, j));
            }

            // check change
            if (clearState === REMOVE_NORMAL) {
                try {
                    const isChange = await this.#checkChange(fileContract, blobHashArr, blobHashRequestArr);
                    if (!isChange) {
                        console.log(`FlatDirectory: The ${chunkIdArr} chunks of file ${key} have not changed.`);
                        cb.onProgress(chunkIdArr, blobLength);
                        continue;
                    }
                } catch (e) {
                    cb.onFail(e);
                    const length = e.message.length;
                    console.log(length > 500 ? (e.message.substring(0, 245) + " ... " + e.message.substring(length - 245, length)) : e.message);
                    return;
                }
            }

            // upload
            try {
                const status = await this.#uploadBlob(fileContract, key, hexName, blobArr, chunkIdArr, chunkSizeArr, cost);
                if (!status) {
                    cb.onFail(new Error("FlatDirectory: Sending transaction failed."));
                    return; //  fail
                }
            } catch (e) {
                cb.onFail(e);
                const length = e.message.length;
                console.log(length > 500 ? (e.message.substring(0, 245) + " ... " + e.message.substring(length - 245, length)) : e.message);
                return;
            }
            // success
            cb.onProgress(chunkIdArr, blobLength);
            totalCost += cost * BigInt(blobArr.length);
            totalUploadCount += blobArr.length;
            for (let i = 0; i < chunkSizeArr.length; i++) {
                totalUploadSize += chunkSizeArr[i];
            }
        }

        cb.onSuccess({
            totalUploadCount,
            totalUploadSize,
            totalCost,
        });
    }

    async #clearOldFile(key, chunkLength, oldChunkLength) {
        if (oldChunkLength > chunkLength) {
            // remove
            const v = await this.remove(key);
            if (v) {
                return REMOVE_SUCCESS;
            } else {
                return REMOVE_FAIL;
            }
        } else if (oldChunkLength === 0) {
            return REMOVE_SUCCESS;
        } else {
            return REMOVE_NORMAL;
        }
    }

    async #checkChange(fileContract, blobHashArr, blobHashRequestArr) {
        let hasChange = false;
        const dataHashArr = await Promise.all(blobHashRequestArr);
        for (let i = 0; i < blobHashArr.length; i++) {
            if (blobHashArr[i] !== dataHashArr[i]) {
                hasChange = true;
                break;
            }
        }
        return hasChange;
    }

    async #uploadBlob(fileContract, key, hexName, blobArr, chunkIdArr, chunkSizeArr, cost) {
        // create tx
        const value = cost * BigInt(blobArr.length);
        const tx = await fileContract.writeChunks.populateTransaction(hexName, chunkIdArr, chunkSizeArr, {
            value: value,
        });
        // send
        const txResponse = await this.#blobUploader.sendTxLock(tx, blobArr);
        console.log(`FlatDirectory: The ${chunkIdArr} chunks of file ${key} hash is ${txResponse.hash}.`);
        const txReceipt = await txResponse.wait();
        return txReceipt && txReceipt.status;
    }
}

export { BLOB_DATA_SIZE, BLOB_SIZE, ETHSTORAGE_MAPPING, EthStorage, EthStorageAbi, FlatDirectory, FlatDirectoryAbi, MAX_BLOB_COUNT, PaddingPer31Bytes, RawData, index as utils };
//# sourceMappingURL=index.esm.js.map
