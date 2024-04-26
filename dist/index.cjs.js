'use strict';

var ethers = require('ethers');
var kzgWasm = require('kzg-wasm');
var fs = require('fs');

const defaultAxios = require("axios");
const axios = defaultAxios.create({
    timeout: 50000,
});

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
    const hash = ethers.ethers.getBytes(ethers.ethers.sha256(commitment));
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
    #provider;
    #wallet;

    constructor(rpc, pk) {
        this.#jsonRpc = rpc;
        this.#provider = new ethers.ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.ethers.Wallet(padHex(pk), this.#provider);
    }

    async #getKzg() {
        if (!this.#kzg) {
            this.#kzg = await kzgWasm.loadKZG();
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
            versionedHashes.push(ethers.ethers.hexlify(hash));
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
        return ethers.ethers.hexlify(hash);
    }
}

const BlobTxBytesPerFieldElement         = 32;      // Size in bytes of a field element
const BlobTxFieldElementsPerBlob         = 4096;
const BLOB_SIZE = BlobTxBytesPerFieldElement * BlobTxFieldElementsPerBlob;
const BLOB_DATA_SIZE = 31 * BlobTxFieldElementsPerBlob;

function EncodeBlobs(data) {
    const len = data.length;
    if (len === 0) {
        throw Error('invalid blob data')
    }

    let blobIndex = 0;
    let fieldIndex = -1;

    const blobs = [new Uint8Array(BLOB_SIZE).fill(0)];
    for (let i = 0; i < len; i += 31) {
        fieldIndex++;
        if (fieldIndex === BlobTxFieldElementsPerBlob) {
            blobs.push(new Uint8Array(BLOB_SIZE).fill(0));
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

function DecodeBlob(blob) {
    if (!blob) {
        throw Error('invalid blob data')
    }

    blob = ethers.ethers.getBytes(blob);
    if (blob.length < BLOB_SIZE) {
        const newBlob = new Uint8Array(BLOB_SIZE).fill(0);
        newBlob.set(blob);
        blob = newBlob;
    }

    let data = [];
    let j = 0;
    for (let i = 0; i < BlobTxFieldElementsPerBlob; i++) {
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

function DecodeBlobs(blobs) {
    if (!blobs) {
        throw Error('invalid blobs')
    }

    blobs = ethers.ethers.getBytes(blobs);
    const len = blobs.length;
    if (len === 0) {
        throw Error('invalid blobs')
    }

    let buf = [];
    for (let i = 0; i < len; i += BLOB_SIZE) {
        let max = i + BLOB_SIZE;
        if (max > len) {
            max = len;
        }
        const blob = blobs.subarray(i, max);
        const blobBuf = DecodeBlob(blob);
        buf = [...buf, ...blobBuf];
    }
    return new Buffer(buf);
}

const contractABI = [
    'function countChunks(bytes memory name) external view returns (uint256)',
    'function readChunk(bytes memory name, uint256 chunkId) external view returns (bytes memory, bool)'
];

const stringToHex$1 = (s) => ethers.ethers.hexlify(ethers.ethers.toUtf8Bytes(s));

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
    const hexName = stringToHex$1(fileName);

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

/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise, SuppressedError, Symbol */

var extendStatics = function(d, b) {
  extendStatics = Object.setPrototypeOf ||
      ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
      function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
  return extendStatics(d, b);
};

function __extends(d, b) {
  if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
  extendStatics(d, b);
  function __() { this.constructor = d; }
  d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
}

function __awaiter(thisArg, _arguments, P, generator) {
  function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
  return new (P || (P = Promise))(function (resolve, reject) {
      function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
      function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
      function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
      step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}

function __generator(thisArg, body) {
  var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
  return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
  function verb(n) { return function (v) { return step([n, v]); }; }
  function step(op) {
      if (f) throw new TypeError("Generator is already executing.");
      while (g && (g = 0, op[0] && (_ = 0)), _) try {
          if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
          if (y = 0, t) op = [op[0] & 2, t.value];
          switch (op[0]) {
              case 0: case 1: t = op; break;
              case 4: _.label++; return { value: op[1], done: false };
              case 5: _.label++; y = op[1]; op = [0]; continue;
              case 7: op = _.ops.pop(); _.trys.pop(); continue;
              default:
                  if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                  if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                  if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                  if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                  if (t[2]) _.ops.pop();
                  _.trys.pop(); continue;
          }
          op = body.call(thisArg, _);
      } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
      if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
  }
}

function __values(o) {
  var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
  if (m) return m.call(o);
  if (o && typeof o.length === "number") return {
      next: function () {
          if (o && i >= o.length) o = void 0;
          return { value: o && o[i++], done: !o };
      }
  };
  throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}

function __read(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
      while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  }
  catch (error) { e = { error: error }; }
  finally {
      try {
          if (r && !r.done && (m = i["return"])) m.call(i);
      }
      finally { if (e) throw e.error; }
  }
  return ar;
}

function __spreadArray(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
      if (ar || !(i in from)) {
          if (!ar) ar = Array.prototype.slice.call(from, 0, i);
          ar[i] = from[i];
      }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
}

function __await(v) {
  return this instanceof __await ? (this.v = v, this) : new __await(v);
}

function __asyncGenerator(thisArg, _arguments, generator) {
  if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
  var g = generator.apply(thisArg, _arguments || []), i, q = [];
  return i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i;
  function verb(n) { if (g[n]) i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; }
  function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
  function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
  function fulfill(value) { resume("next", value); }
  function reject(value) { resume("throw", value); }
  function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
}

function __asyncValues(o) {
  if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
  var m = o[Symbol.asyncIterator], i;
  return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
  function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
  function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
}

typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
  var e = new Error(message);
  return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

function isFunction(value) {
    return typeof value === 'function';
}

function createErrorClass(createImpl) {
    var _super = function (instance) {
        Error.call(instance);
        instance.stack = new Error().stack;
    };
    var ctorFunc = createImpl(_super);
    ctorFunc.prototype = Object.create(Error.prototype);
    ctorFunc.prototype.constructor = ctorFunc;
    return ctorFunc;
}

var UnsubscriptionError = createErrorClass(function (_super) {
    return function UnsubscriptionErrorImpl(errors) {
        _super(this);
        this.message = errors
            ? errors.length + " errors occurred during unsubscription:\n" + errors.map(function (err, i) { return i + 1 + ") " + err.toString(); }).join('\n  ')
            : '';
        this.name = 'UnsubscriptionError';
        this.errors = errors;
    };
});

function arrRemove(arr, item) {
    if (arr) {
        var index = arr.indexOf(item);
        0 <= index && arr.splice(index, 1);
    }
}

var Subscription = (function () {
    function Subscription(initialTeardown) {
        this.initialTeardown = initialTeardown;
        this.closed = false;
        this._parentage = null;
        this._finalizers = null;
    }
    Subscription.prototype.unsubscribe = function () {
        var e_1, _a, e_2, _b;
        var errors;
        if (!this.closed) {
            this.closed = true;
            var _parentage = this._parentage;
            if (_parentage) {
                this._parentage = null;
                if (Array.isArray(_parentage)) {
                    try {
                        for (var _parentage_1 = __values(_parentage), _parentage_1_1 = _parentage_1.next(); !_parentage_1_1.done; _parentage_1_1 = _parentage_1.next()) {
                            var parent_1 = _parentage_1_1.value;
                            parent_1.remove(this);
                        }
                    }
                    catch (e_1_1) { e_1 = { error: e_1_1 }; }
                    finally {
                        try {
                            if (_parentage_1_1 && !_parentage_1_1.done && (_a = _parentage_1.return)) _a.call(_parentage_1);
                        }
                        finally { if (e_1) throw e_1.error; }
                    }
                }
                else {
                    _parentage.remove(this);
                }
            }
            var initialFinalizer = this.initialTeardown;
            if (isFunction(initialFinalizer)) {
                try {
                    initialFinalizer();
                }
                catch (e) {
                    errors = e instanceof UnsubscriptionError ? e.errors : [e];
                }
            }
            var _finalizers = this._finalizers;
            if (_finalizers) {
                this._finalizers = null;
                try {
                    for (var _finalizers_1 = __values(_finalizers), _finalizers_1_1 = _finalizers_1.next(); !_finalizers_1_1.done; _finalizers_1_1 = _finalizers_1.next()) {
                        var finalizer = _finalizers_1_1.value;
                        try {
                            execFinalizer(finalizer);
                        }
                        catch (err) {
                            errors = errors !== null && errors !== void 0 ? errors : [];
                            if (err instanceof UnsubscriptionError) {
                                errors = __spreadArray(__spreadArray([], __read(errors)), __read(err.errors));
                            }
                            else {
                                errors.push(err);
                            }
                        }
                    }
                }
                catch (e_2_1) { e_2 = { error: e_2_1 }; }
                finally {
                    try {
                        if (_finalizers_1_1 && !_finalizers_1_1.done && (_b = _finalizers_1.return)) _b.call(_finalizers_1);
                    }
                    finally { if (e_2) throw e_2.error; }
                }
            }
            if (errors) {
                throw new UnsubscriptionError(errors);
            }
        }
    };
    Subscription.prototype.add = function (teardown) {
        var _a;
        if (teardown && teardown !== this) {
            if (this.closed) {
                execFinalizer(teardown);
            }
            else {
                if (teardown instanceof Subscription) {
                    if (teardown.closed || teardown._hasParent(this)) {
                        return;
                    }
                    teardown._addParent(this);
                }
                (this._finalizers = (_a = this._finalizers) !== null && _a !== void 0 ? _a : []).push(teardown);
            }
        }
    };
    Subscription.prototype._hasParent = function (parent) {
        var _parentage = this._parentage;
        return _parentage === parent || (Array.isArray(_parentage) && _parentage.includes(parent));
    };
    Subscription.prototype._addParent = function (parent) {
        var _parentage = this._parentage;
        this._parentage = Array.isArray(_parentage) ? (_parentage.push(parent), _parentage) : _parentage ? [_parentage, parent] : parent;
    };
    Subscription.prototype._removeParent = function (parent) {
        var _parentage = this._parentage;
        if (_parentage === parent) {
            this._parentage = null;
        }
        else if (Array.isArray(_parentage)) {
            arrRemove(_parentage, parent);
        }
    };
    Subscription.prototype.remove = function (teardown) {
        var _finalizers = this._finalizers;
        _finalizers && arrRemove(_finalizers, teardown);
        if (teardown instanceof Subscription) {
            teardown._removeParent(this);
        }
    };
    Subscription.EMPTY = (function () {
        var empty = new Subscription();
        empty.closed = true;
        return empty;
    })();
    return Subscription;
}());
Subscription.EMPTY;
function isSubscription(value) {
    return (value instanceof Subscription ||
        (value && 'closed' in value && isFunction(value.remove) && isFunction(value.add) && isFunction(value.unsubscribe)));
}
function execFinalizer(finalizer) {
    if (isFunction(finalizer)) {
        finalizer();
    }
    else {
        finalizer.unsubscribe();
    }
}

var config = {
    onUnhandledError: null,
    onStoppedNotification: null,
    Promise: undefined,
    useDeprecatedSynchronousErrorHandling: false,
    useDeprecatedNextContext: false,
};

var timeoutProvider = {
    setTimeout: function (handler, timeout) {
        var args = [];
        for (var _i = 2; _i < arguments.length; _i++) {
            args[_i - 2] = arguments[_i];
        }
        return setTimeout.apply(void 0, __spreadArray([handler, timeout], __read(args)));
    },
    clearTimeout: function (handle) {
        var delegate = timeoutProvider.delegate;
        return ((delegate === null || delegate === void 0 ? void 0 : delegate.clearTimeout) || clearTimeout)(handle);
    },
    delegate: undefined,
};

function reportUnhandledError(err) {
    timeoutProvider.setTimeout(function () {
        {
            throw err;
        }
    });
}

function noop() { }

function errorContext(cb) {
    {
        cb();
    }
}

var Subscriber = (function (_super) {
    __extends(Subscriber, _super);
    function Subscriber(destination) {
        var _this = _super.call(this) || this;
        _this.isStopped = false;
        if (destination) {
            _this.destination = destination;
            if (isSubscription(destination)) {
                destination.add(_this);
            }
        }
        else {
            _this.destination = EMPTY_OBSERVER;
        }
        return _this;
    }
    Subscriber.create = function (next, error, complete) {
        return new SafeSubscriber(next, error, complete);
    };
    Subscriber.prototype.next = function (value) {
        if (this.isStopped) ;
        else {
            this._next(value);
        }
    };
    Subscriber.prototype.error = function (err) {
        if (this.isStopped) ;
        else {
            this.isStopped = true;
            this._error(err);
        }
    };
    Subscriber.prototype.complete = function () {
        if (this.isStopped) ;
        else {
            this.isStopped = true;
            this._complete();
        }
    };
    Subscriber.prototype.unsubscribe = function () {
        if (!this.closed) {
            this.isStopped = true;
            _super.prototype.unsubscribe.call(this);
            this.destination = null;
        }
    };
    Subscriber.prototype._next = function (value) {
        this.destination.next(value);
    };
    Subscriber.prototype._error = function (err) {
        try {
            this.destination.error(err);
        }
        finally {
            this.unsubscribe();
        }
    };
    Subscriber.prototype._complete = function () {
        try {
            this.destination.complete();
        }
        finally {
            this.unsubscribe();
        }
    };
    return Subscriber;
}(Subscription));
var _bind = Function.prototype.bind;
function bind(fn, thisArg) {
    return _bind.call(fn, thisArg);
}
var ConsumerObserver = (function () {
    function ConsumerObserver(partialObserver) {
        this.partialObserver = partialObserver;
    }
    ConsumerObserver.prototype.next = function (value) {
        var partialObserver = this.partialObserver;
        if (partialObserver.next) {
            try {
                partialObserver.next(value);
            }
            catch (error) {
                handleUnhandledError(error);
            }
        }
    };
    ConsumerObserver.prototype.error = function (err) {
        var partialObserver = this.partialObserver;
        if (partialObserver.error) {
            try {
                partialObserver.error(err);
            }
            catch (error) {
                handleUnhandledError(error);
            }
        }
        else {
            handleUnhandledError(err);
        }
    };
    ConsumerObserver.prototype.complete = function () {
        var partialObserver = this.partialObserver;
        if (partialObserver.complete) {
            try {
                partialObserver.complete();
            }
            catch (error) {
                handleUnhandledError(error);
            }
        }
    };
    return ConsumerObserver;
}());
var SafeSubscriber = (function (_super) {
    __extends(SafeSubscriber, _super);
    function SafeSubscriber(observerOrNext, error, complete) {
        var _this = _super.call(this) || this;
        var partialObserver;
        if (isFunction(observerOrNext) || !observerOrNext) {
            partialObserver = {
                next: (observerOrNext !== null && observerOrNext !== void 0 ? observerOrNext : undefined),
                error: error !== null && error !== void 0 ? error : undefined,
                complete: complete !== null && complete !== void 0 ? complete : undefined,
            };
        }
        else {
            var context_1;
            if (_this && config.useDeprecatedNextContext) {
                context_1 = Object.create(observerOrNext);
                context_1.unsubscribe = function () { return _this.unsubscribe(); };
                partialObserver = {
                    next: observerOrNext.next && bind(observerOrNext.next, context_1),
                    error: observerOrNext.error && bind(observerOrNext.error, context_1),
                    complete: observerOrNext.complete && bind(observerOrNext.complete, context_1),
                };
            }
            else {
                partialObserver = observerOrNext;
            }
        }
        _this.destination = new ConsumerObserver(partialObserver);
        return _this;
    }
    return SafeSubscriber;
}(Subscriber));
function handleUnhandledError(error) {
    {
        reportUnhandledError(error);
    }
}
function defaultErrorHandler(err) {
    throw err;
}
var EMPTY_OBSERVER = {
    closed: true,
    next: noop,
    error: defaultErrorHandler,
    complete: noop,
};

var observable = (function () { return (typeof Symbol === 'function' && Symbol.observable) || '@@observable'; })();

function identity(x) {
    return x;
}

function pipeFromArray(fns) {
    if (fns.length === 0) {
        return identity;
    }
    if (fns.length === 1) {
        return fns[0];
    }
    return function piped(input) {
        return fns.reduce(function (prev, fn) { return fn(prev); }, input);
    };
}

var Observable = (function () {
    function Observable(subscribe) {
        if (subscribe) {
            this._subscribe = subscribe;
        }
    }
    Observable.prototype.lift = function (operator) {
        var observable = new Observable();
        observable.source = this;
        observable.operator = operator;
        return observable;
    };
    Observable.prototype.subscribe = function (observerOrNext, error, complete) {
        var _this = this;
        var subscriber = isSubscriber(observerOrNext) ? observerOrNext : new SafeSubscriber(observerOrNext, error, complete);
        errorContext(function () {
            var _a = _this, operator = _a.operator, source = _a.source;
            subscriber.add(operator
                ?
                    operator.call(subscriber, source)
                : source
                    ?
                        _this._subscribe(subscriber)
                    :
                        _this._trySubscribe(subscriber));
        });
        return subscriber;
    };
    Observable.prototype._trySubscribe = function (sink) {
        try {
            return this._subscribe(sink);
        }
        catch (err) {
            sink.error(err);
        }
    };
    Observable.prototype.forEach = function (next, promiseCtor) {
        var _this = this;
        promiseCtor = getPromiseCtor(promiseCtor);
        return new promiseCtor(function (resolve, reject) {
            var subscriber = new SafeSubscriber({
                next: function (value) {
                    try {
                        next(value);
                    }
                    catch (err) {
                        reject(err);
                        subscriber.unsubscribe();
                    }
                },
                error: reject,
                complete: resolve,
            });
            _this.subscribe(subscriber);
        });
    };
    Observable.prototype._subscribe = function (subscriber) {
        var _a;
        return (_a = this.source) === null || _a === void 0 ? void 0 : _a.subscribe(subscriber);
    };
    Observable.prototype[observable] = function () {
        return this;
    };
    Observable.prototype.pipe = function () {
        var operations = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            operations[_i] = arguments[_i];
        }
        return pipeFromArray(operations)(this);
    };
    Observable.prototype.toPromise = function (promiseCtor) {
        var _this = this;
        promiseCtor = getPromiseCtor(promiseCtor);
        return new promiseCtor(function (resolve, reject) {
            var value;
            _this.subscribe(function (x) { return (value = x); }, function (err) { return reject(err); }, function () { return resolve(value); });
        });
    };
    Observable.create = function (subscribe) {
        return new Observable(subscribe);
    };
    return Observable;
}());
function getPromiseCtor(promiseCtor) {
    var _a;
    return (_a = promiseCtor !== null && promiseCtor !== void 0 ? promiseCtor : config.Promise) !== null && _a !== void 0 ? _a : Promise;
}
function isObserver(value) {
    return value && isFunction(value.next) && isFunction(value.error) && isFunction(value.complete);
}
function isSubscriber(value) {
    return (value && value instanceof Subscriber) || (isObserver(value) && isSubscription(value));
}

function hasLift(source) {
    return isFunction(source === null || source === void 0 ? void 0 : source.lift);
}
function operate(init) {
    return function (source) {
        if (hasLift(source)) {
            return source.lift(function (liftedSource) {
                try {
                    return init(liftedSource, this);
                }
                catch (err) {
                    this.error(err);
                }
            });
        }
        throw new TypeError('Unable to lift unknown Observable type');
    };
}

function createOperatorSubscriber(destination, onNext, onComplete, onError, onFinalize) {
    return new OperatorSubscriber(destination, onNext, onComplete, onError, onFinalize);
}
var OperatorSubscriber = (function (_super) {
    __extends(OperatorSubscriber, _super);
    function OperatorSubscriber(destination, onNext, onComplete, onError, onFinalize, shouldUnsubscribe) {
        var _this = _super.call(this, destination) || this;
        _this.onFinalize = onFinalize;
        _this.shouldUnsubscribe = shouldUnsubscribe;
        _this._next = onNext
            ? function (value) {
                try {
                    onNext(value);
                }
                catch (err) {
                    destination.error(err);
                }
            }
            : _super.prototype._next;
        _this._error = onError
            ? function (err) {
                try {
                    onError(err);
                }
                catch (err) {
                    destination.error(err);
                }
                finally {
                    this.unsubscribe();
                }
            }
            : _super.prototype._error;
        _this._complete = onComplete
            ? function () {
                try {
                    onComplete();
                }
                catch (err) {
                    destination.error(err);
                }
                finally {
                    this.unsubscribe();
                }
            }
            : _super.prototype._complete;
        return _this;
    }
    OperatorSubscriber.prototype.unsubscribe = function () {
        var _a;
        if (!this.shouldUnsubscribe || this.shouldUnsubscribe()) {
            var closed_1 = this.closed;
            _super.prototype.unsubscribe.call(this);
            !closed_1 && ((_a = this.onFinalize) === null || _a === void 0 ? void 0 : _a.call(this));
        }
    };
    return OperatorSubscriber;
}(Subscriber));

var isArrayLike = (function (x) { return x && typeof x.length === 'number' && typeof x !== 'function'; });

function isPromise(value) {
    return isFunction(value === null || value === void 0 ? void 0 : value.then);
}

function isInteropObservable(input) {
    return isFunction(input[observable]);
}

function isAsyncIterable(obj) {
    return Symbol.asyncIterator && isFunction(obj === null || obj === void 0 ? void 0 : obj[Symbol.asyncIterator]);
}

function createInvalidObservableTypeError(input) {
    return new TypeError("You provided " + (input !== null && typeof input === 'object' ? 'an invalid object' : "'" + input + "'") + " where a stream was expected. You can provide an Observable, Promise, ReadableStream, Array, AsyncIterable, or Iterable.");
}

function getSymbolIterator() {
    if (typeof Symbol !== 'function' || !Symbol.iterator) {
        return '@@iterator';
    }
    return Symbol.iterator;
}
var iterator = getSymbolIterator();

function isIterable(input) {
    return isFunction(input === null || input === void 0 ? void 0 : input[iterator]);
}

function readableStreamLikeToAsyncGenerator(readableStream) {
    return __asyncGenerator(this, arguments, function readableStreamLikeToAsyncGenerator_1() {
        var reader, _a, value, done;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    reader = readableStream.getReader();
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, , 9, 10]);
                    _b.label = 2;
                case 2:
                    return [4, __await(reader.read())];
                case 3:
                    _a = _b.sent(), value = _a.value, done = _a.done;
                    if (!done) return [3, 5];
                    return [4, __await(void 0)];
                case 4: return [2, _b.sent()];
                case 5: return [4, __await(value)];
                case 6: return [4, _b.sent()];
                case 7:
                    _b.sent();
                    return [3, 2];
                case 8: return [3, 10];
                case 9:
                    reader.releaseLock();
                    return [7];
                case 10: return [2];
            }
        });
    });
}
function isReadableStreamLike(obj) {
    return isFunction(obj === null || obj === void 0 ? void 0 : obj.getReader);
}

function innerFrom(input) {
    if (input instanceof Observable) {
        return input;
    }
    if (input != null) {
        if (isInteropObservable(input)) {
            return fromInteropObservable(input);
        }
        if (isArrayLike(input)) {
            return fromArrayLike(input);
        }
        if (isPromise(input)) {
            return fromPromise(input);
        }
        if (isAsyncIterable(input)) {
            return fromAsyncIterable(input);
        }
        if (isIterable(input)) {
            return fromIterable(input);
        }
        if (isReadableStreamLike(input)) {
            return fromReadableStreamLike(input);
        }
    }
    throw createInvalidObservableTypeError(input);
}
function fromInteropObservable(obj) {
    return new Observable(function (subscriber) {
        var obs = obj[observable]();
        if (isFunction(obs.subscribe)) {
            return obs.subscribe(subscriber);
        }
        throw new TypeError('Provided object does not correctly implement Symbol.observable');
    });
}
function fromArrayLike(array) {
    return new Observable(function (subscriber) {
        for (var i = 0; i < array.length && !subscriber.closed; i++) {
            subscriber.next(array[i]);
        }
        subscriber.complete();
    });
}
function fromPromise(promise) {
    return new Observable(function (subscriber) {
        promise
            .then(function (value) {
            if (!subscriber.closed) {
                subscriber.next(value);
                subscriber.complete();
            }
        }, function (err) { return subscriber.error(err); })
            .then(null, reportUnhandledError);
    });
}
function fromIterable(iterable) {
    return new Observable(function (subscriber) {
        var e_1, _a;
        try {
            for (var iterable_1 = __values(iterable), iterable_1_1 = iterable_1.next(); !iterable_1_1.done; iterable_1_1 = iterable_1.next()) {
                var value = iterable_1_1.value;
                subscriber.next(value);
                if (subscriber.closed) {
                    return;
                }
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (iterable_1_1 && !iterable_1_1.done && (_a = iterable_1.return)) _a.call(iterable_1);
            }
            finally { if (e_1) throw e_1.error; }
        }
        subscriber.complete();
    });
}
function fromAsyncIterable(asyncIterable) {
    return new Observable(function (subscriber) {
        process$1(asyncIterable, subscriber).catch(function (err) { return subscriber.error(err); });
    });
}
function fromReadableStreamLike(readableStream) {
    return fromAsyncIterable(readableStreamLikeToAsyncGenerator(readableStream));
}
function process$1(asyncIterable, subscriber) {
    var asyncIterable_1, asyncIterable_1_1;
    var e_2, _a;
    return __awaiter(this, void 0, void 0, function () {
        var value, e_2_1;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 5, 6, 11]);
                    asyncIterable_1 = __asyncValues(asyncIterable);
                    _b.label = 1;
                case 1: return [4, asyncIterable_1.next()];
                case 2:
                    if (!(asyncIterable_1_1 = _b.sent(), !asyncIterable_1_1.done)) return [3, 4];
                    value = asyncIterable_1_1.value;
                    subscriber.next(value);
                    if (subscriber.closed) {
                        return [2];
                    }
                    _b.label = 3;
                case 3: return [3, 1];
                case 4: return [3, 11];
                case 5:
                    e_2_1 = _b.sent();
                    e_2 = { error: e_2_1 };
                    return [3, 11];
                case 6:
                    _b.trys.push([6, , 9, 10]);
                    if (!(asyncIterable_1_1 && !asyncIterable_1_1.done && (_a = asyncIterable_1.return))) return [3, 8];
                    return [4, _a.call(asyncIterable_1)];
                case 7:
                    _b.sent();
                    _b.label = 8;
                case 8: return [3, 10];
                case 9:
                    if (e_2) throw e_2.error;
                    return [7];
                case 10: return [7];
                case 11:
                    subscriber.complete();
                    return [2];
            }
        });
    });
}

function executeSchedule(parentSubscription, scheduler, work, delay, repeat) {
    if (delay === void 0) { delay = 0; }
    if (repeat === void 0) { repeat = false; }
    var scheduleSubscription = scheduler.schedule(function () {
        work();
        if (repeat) {
            parentSubscription.add(this.schedule(null, delay));
        }
        else {
            this.unsubscribe();
        }
    }, delay);
    parentSubscription.add(scheduleSubscription);
    if (!repeat) {
        return scheduleSubscription;
    }
}

function observeOn(scheduler, delay) {
    if (delay === void 0) { delay = 0; }
    return operate(function (source, subscriber) {
        source.subscribe(createOperatorSubscriber(subscriber, function (value) { return executeSchedule(subscriber, scheduler, function () { return subscriber.next(value); }, delay); }, function () { return executeSchedule(subscriber, scheduler, function () { return subscriber.complete(); }, delay); }, function (err) { return executeSchedule(subscriber, scheduler, function () { return subscriber.error(err); }, delay); }));
    });
}

function subscribeOn(scheduler, delay) {
    if (delay === void 0) { delay = 0; }
    return operate(function (source, subscriber) {
        subscriber.add(scheduler.schedule(function () { return source.subscribe(subscriber); }, delay));
    });
}

function scheduleObservable(input, scheduler) {
    return innerFrom(input).pipe(subscribeOn(scheduler), observeOn(scheduler));
}

function schedulePromise(input, scheduler) {
    return innerFrom(input).pipe(subscribeOn(scheduler), observeOn(scheduler));
}

function scheduleArray(input, scheduler) {
    return new Observable(function (subscriber) {
        var i = 0;
        return scheduler.schedule(function () {
            if (i === input.length) {
                subscriber.complete();
            }
            else {
                subscriber.next(input[i++]);
                if (!subscriber.closed) {
                    this.schedule();
                }
            }
        });
    });
}

function scheduleIterable(input, scheduler) {
    return new Observable(function (subscriber) {
        var iterator$1;
        executeSchedule(subscriber, scheduler, function () {
            iterator$1 = input[iterator]();
            executeSchedule(subscriber, scheduler, function () {
                var _a;
                var value;
                var done;
                try {
                    (_a = iterator$1.next(), value = _a.value, done = _a.done);
                }
                catch (err) {
                    subscriber.error(err);
                    return;
                }
                if (done) {
                    subscriber.complete();
                }
                else {
                    subscriber.next(value);
                }
            }, 0, true);
        });
        return function () { return isFunction(iterator$1 === null || iterator$1 === void 0 ? void 0 : iterator$1.return) && iterator$1.return(); };
    });
}

function scheduleAsyncIterable(input, scheduler) {
    if (!input) {
        throw new Error('Iterable cannot be null');
    }
    return new Observable(function (subscriber) {
        executeSchedule(subscriber, scheduler, function () {
            var iterator = input[Symbol.asyncIterator]();
            executeSchedule(subscriber, scheduler, function () {
                iterator.next().then(function (result) {
                    if (result.done) {
                        subscriber.complete();
                    }
                    else {
                        subscriber.next(result.value);
                    }
                });
            }, 0, true);
        });
    });
}

function scheduleReadableStreamLike(input, scheduler) {
    return scheduleAsyncIterable(readableStreamLikeToAsyncGenerator(input), scheduler);
}

function scheduled(input, scheduler) {
    if (input != null) {
        if (isInteropObservable(input)) {
            return scheduleObservable(input, scheduler);
        }
        if (isArrayLike(input)) {
            return scheduleArray(input, scheduler);
        }
        if (isPromise(input)) {
            return schedulePromise(input, scheduler);
        }
        if (isAsyncIterable(input)) {
            return scheduleAsyncIterable(input, scheduler);
        }
        if (isIterable(input)) {
            return scheduleIterable(input, scheduler);
        }
        if (isReadableStreamLike(input)) {
            return scheduleReadableStreamLike(input, scheduler);
        }
    }
    throw createInvalidObservableTypeError(input);
}

function from(input, scheduler) {
    return scheduler ? scheduled(input, scheduler) : innerFrom(input);
}

function map(project, thisArg) {
    return operate(function (source, subscriber) {
        var index = 0;
        source.subscribe(createOperatorSubscriber(subscriber, function (value) {
            subscriber.next(project.call(thisArg, value, index++));
        }));
    });
}

function mergeInternals(source, subscriber, project, concurrent, onBeforeNext, expand, innerSubScheduler, additionalFinalizer) {
    var buffer = [];
    var active = 0;
    var index = 0;
    var isComplete = false;
    var checkComplete = function () {
        if (isComplete && !buffer.length && !active) {
            subscriber.complete();
        }
    };
    var outerNext = function (value) { return (active < concurrent ? doInnerSub(value) : buffer.push(value)); };
    var doInnerSub = function (value) {
        expand && subscriber.next(value);
        active++;
        var innerComplete = false;
        innerFrom(project(value, index++)).subscribe(createOperatorSubscriber(subscriber, function (innerValue) {
            onBeforeNext === null || onBeforeNext === void 0 ? void 0 : onBeforeNext(innerValue);
            if (expand) {
                outerNext(innerValue);
            }
            else {
                subscriber.next(innerValue);
            }
        }, function () {
            innerComplete = true;
        }, undefined, function () {
            if (innerComplete) {
                try {
                    active--;
                    var _loop_1 = function () {
                        var bufferedValue = buffer.shift();
                        if (innerSubScheduler) {
                            executeSchedule(subscriber, innerSubScheduler, function () { return doInnerSub(bufferedValue); });
                        }
                        else {
                            doInnerSub(bufferedValue);
                        }
                    };
                    while (buffer.length && active < concurrent) {
                        _loop_1();
                    }
                    checkComplete();
                }
                catch (err) {
                    subscriber.error(err);
                }
            }
        }));
    };
    source.subscribe(createOperatorSubscriber(subscriber, outerNext, function () {
        isComplete = true;
        checkComplete();
    }));
    return function () {
        additionalFinalizer === null || additionalFinalizer === void 0 ? void 0 : additionalFinalizer();
    };
}

function mergeMap(project, resultSelector, concurrent) {
    if (concurrent === void 0) { concurrent = Infinity; }
    if (isFunction(resultSelector)) {
        return mergeMap(function (a, i) { return map(function (b, ii) { return resultSelector(a, b, i, ii); })(innerFrom(project(a, i))); }, concurrent);
    }
    else if (typeof resultSelector === 'number') {
        concurrent = resultSelector;
    }
    return operate(function (source, subscriber) { return mergeInternals(source, subscriber, project, concurrent); });
}

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

var stylesName = {
  // 字背景颜色范围:40~49
  // 40:黑, 41:深红, 42:绿, 43:黄色, 44:蓝色, 45:紫色, 46:深绿, 47:白色,
  // 字颜色:30~39
  // 30:黑, 31:红, 32:绿, 33:黄, 34:蓝色, 35:紫色, 36:深绿, 37:白色,
  //
  // echo -e "\x1b[31;1m color red underline \x1b[0m"
  // 1m 亮的颜色，默认不给是暗淡的颜色
  //
  // |    ANSI |    ANSI |    ANSI    |                | Aixterm | Aixterm
  // |   Color | FG Code | BG Code    | Bright Color   | FG Code | BG Code
  // +---------+---------+--------    +----------------+---------+--------
  // |   Black |      30 |      40    |   Bright Black |      90 |     100
  // |     Red |      31 |      41    |     Bright Red |      91 |     101
  // |   Green |      32 |      42    |   Bright Green |      92 |     102
  // |  Yellow |      33 |      43    |  Bright Yellow |      93 |     103
  // |    Blue |      34 |      44    |    Bright Blue |      94 |     104
  // | Magenta |      35 |      45    | Bright Magenta |      95 |     105
  // |    Cyan |      36 |      46    |    Bright Cyan |      96 |     106
  // |   White |      37 |      47    |   Bright White |      97 |     107
  //
  colors: [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white'
  ],
  styles:[
    'bold', //粗体
    'faint',
    'italic',
    'underline',
    'blink',
    'overline',
    'inverse',
    'conceal',
    'strike'
  ]
};

// https://github.com/chalk/ansi-regex/blob/master/index.js

var ansiRegex$1 = function () {
  const pattern = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PRZcf-ntqry=><~]))'
  ].join('|');
  return new RegExp(pattern, 'g');
};

var color$2 = {};

var argv = process.argv;

var supportsColors = (function () {
  if (argv.indexOf('--no-color') !== -1 ||
    argv.indexOf('--color=false') !== -1) {
    return false;
  }

  if (argv.indexOf('--color') !== -1 ||
    argv.indexOf('--color=true') !== -1 ||
    argv.indexOf('--color=always') !== -1) {
    return true;
  }

  if (process.stdout && !process.stdout.isTTY) {
    return false;
  }

  if (process.platform === 'win32') {
    return true;
  }

  if ('COLORTERM' in process.env) {
    return true;
  }

  if (process.env.TERM === 'dumb') {
    return false;
  }

  if (/^screen|^xterm|^vt100|color|ansi|cygwin|linux/i.test(process.env.TERM)) {
    return true;
  }

  return false;
})();

/**
 *
 * [The opaque named colors](https://drafts.csswg.org/css-color/#named-colors)
 * [ANSI Escape sequences](http://ascii-table.com/ansi-escape-sequences.php)
 * [ANSI escape code](https://en.wikipedia.org/wiki/ANSI_escape_code)
 * [Linux Shell Scripting Tutorial](http://www.freeos.com/guides/lsst/misc.htm#colorfunandmore)
 *
 * [tip colors and formatting](http://misc.flogisoft.com/bash/tip_colors_and_formatting)
 *
 */

(function (exports) {
	var _styles = stylesName;
	var isSupported = supportsColors;
	var colors = _styles.colors;
	var styles = _styles.styles;

	exports.color = {};

	function Colors(str){
	  this.string = str;
	  this.styles = [];
	  this.fgcolor = null;    // Foreground
	  this.bgcolor = null;    // Background
	  this.fgcolor_bt = null; // Bright Foreground
	  this.bgcolor_bt = null; // Bright Background
	  this.fgcolor_x = null;  // 256 Foreground
	  this.bgcolor_x = null; // 256 Background
	}

	// 字背景颜色范围:40~49
	// 40:黑, 41:深红, 42:绿, 43:黄色, 44:蓝色, 45:紫色, 46:深绿, 47:白色,
	// 字颜色:30~39
	// 30:黑, 31:红, 32:绿, 33:黄, 34:蓝色, 35:紫色, 36:深绿, 37:白色,
	//
	// echo -e "\x1b[31;1m color red underline \x1b[0m"
	// 1m 亮的颜色，默认不给是暗淡的颜色
	//
	// |    ANSI |    ANSI |    ANSI    |                | Aixterm | Aixterm
	// |   Color | FG Code | BG Code    | Bright Color   | FG Code | BG Code
	// +---------+---------+--------    +----------------+---------+--------
	// |   Black |      30 |      40    |   Bright Black |      90 |     100
	// |     Red |      31 |      41    |     Bright Red |      91 |     101
	// |   Green |      32 |      42    |   Bright Green |      92 |     102
	// |  Yellow |      33 |      43    |  Bright Yellow |      93 |     103
	// |    Blue |      34 |      44    |    Bright Blue |      94 |     104
	// | Magenta |      35 |      45    | Bright Magenta |      95 |     105
	// |    Cyan |      36 |      46    |    Bright Cyan |      96 |     106
	// |   White |      37 |      47    |   Bright White |      97 |     107
	//

	for (var i = 0; i < colors.length; i++) {
	  (function(i){
	    var name = colors[i];
	    Object.defineProperty(Colors.prototype, name, {
	      get: function() {
	        // Foreground 前景色
	        this.fgcolor = i;
	        return this;
	      }
	    });
	    Object.defineProperty(Colors.prototype, name + '_b', {
	      get: function () {
	        // Background 背景色
	        this.bgcolor = i;
	        return this;
	      }
	    });
	    Object.defineProperty(Colors.prototype, name + '_bt', {
	      get: function () {
	        // Bright Foreground 明亮 前景色
	        this.fgcolor_bt = i;
	        return this;
	      }
	    });
	    Object.defineProperty(Colors.prototype, name + '_bbt', {
	      get: function () {
	        // Bright Background 明亮 背景色
	        this.bgcolor_bt = i;
	        return this;
	      }
	    });

	    exports.color[name] = exports[name] = function(text) {
	      if (!isSupported) return text;
	      return '\x1b[' + (30 + i) + 'm' + text + '\x1b[0m';
	    };
	    exports.color[name + '_b'] = exports[name + '_b'] = function(text) {
	      if (!isSupported) return text;
	      return '\x1b[' + (40 + i) + 'm' + text + '\x1b[0m';
	    };

	    exports.color[name + '_bt'] = exports[name + '_bt'] = function(text) {
	      if (!isSupported) return text;
	      return '\x1b[' + (90 + i) + 'm' + text + '\x1b[0m';
	    };
	    exports.color[name + '_bbt'] = exports[name + '_bbt'] = function(text) {
	      if (!isSupported) return text;
	      return '\x1b[' + (100 + i) + 'm' + text + '\x1b[0m';
	    };
	  })(i);
	}


	for (var i = 0; i < 256; i++) {
	  (function(i){
	    Object.defineProperty(Colors.prototype, 'x'+i, {
	      get: function() {
	        this.fgcolor_x = i;
	        return this;
	      }
	    });
	    Object.defineProperty(Colors.prototype, 'xb'+i, {
	      get: function() {
	        this.bgcolor_x = i;
	        return this;
	      }
	    });

	    exports.color['x'+i] = exports['x'+i] = function(text) {
	      if (!isSupported) return text;
	      return '\x1b[38;5;' + i + 'm' + text + '\x1b[0m';
	    };

	    exports.color['xb'+i] = exports['xb'+i] = function(text) {
	      if (!isSupported) return text;
	      return '\x1b[48;5;' + i + 'm' + text + '\x1b[0m';
	    };
	  })(i);
	}
	/**
	 * ANSI控制码的说明
	 *
	 * 33[0m 关闭所有属性
	 * 33[1m 设置高亮度
	 * 33[4m 下划线
	 * 33[5m 闪烁
	 * 33[7m 反显
	 * 33[8m 消隐
	 * 33[30m -- 33[37m 设置前景色
	 * 33[40m -- 33[47m 设置背景色
	 * 33[nA 光标上移n行
	 * 33[nB 光标下移n行
	 * 33[nC 光标右移n行
	 * 33[nD 光标左移n行
	 * 33[y;xH设置光标位置
	 * 33[2J 清屏
	 * 33[K 清除从光标到行尾的内容
	 * 33[s 保存光标位置
	 * 33[u 恢复光标位置
	 * 33[?25l 隐藏光标
	 * 33[?25h 显示光标
	 */

	for (var i = 0; i < styles.length; i++) {
	  (function(i) {
	    var name = styles[i];
	    Object.defineProperty(Colors.prototype, name, {
	      get: function() {
	        if (this.styles.indexOf(i) === -1) {
	          this.styles = this.styles.concat(i + 1);
	        }
	        return this;
	      }
	    });
	    exports.color[name] = exports[name] = function(text) {
	      if (!isSupported) return text;
	      return '\x1b[' + (i + 1) + 'm' + text + '\x1b[0m';
	    };
	  })(i);
	}

	Colors.prototype.colored = function (text) {
	  var reset = '\x1b[0m';
	  var is256 = isSupported;
	  // 256 Foreground 256 前景色
	  if (this.fgcolor_x && this.fgcolor_x !== null && is256) {
	    text = '\x1b[38;5;' + this.fgcolor_x + 'm' + text + reset;
	  }
	  // 256 Foreground 256 前景色
	  if (this.bgcolor_x && this.bgcolor_x !== null && is256) {
	    text = '\x1b[48;5;' + this.bgcolor_x + 'm' + text + reset;
	  }
	  // Foreground 前景色
	  if (this.fgcolor !== null && this.fgcolor < 8) {
	    text = '\x1b[' + (30 + this.fgcolor) + 'm' + text + reset;
	  }
	  // Bright Foreground 亮 前景色
	  if (this.fgcolor_bt !== null && this.fgcolor_bt < 8) {
	    text = '\x1b[' + (90 + this.fgcolor_bt) + 'm' + text + reset;
	  }
	  // Background 背景色
	  if (this.bgcolor !== null && this.bgcolor < 8) {
	    text = '\x1b[' + (40 + this.bgcolor) + 'm' + text + reset;
	  }
	  // Bright Background 亮 背景色
	  if (this.bgcolor_bt !== null && this.bgcolor_bt < 8) {
	    text = '\x1b[' + (100 + this.bgcolor_bt) + 'm' + text + reset;
	  }

	  if (this.styles && this.styles.length) {
	    text = '\x1b[' + this.styles.join(';') + 'm' + text + reset;
	  }
	  return text;
	};

	Colors.prototype.valueOf = function(type){
	  var text = this.string;
	  text = this.colored(text);
	  return text;
	};

	exports.Colors = Colors; 
} (color$2));

var colors$1 = {};
var colorSafe = colors$1;

var defineProps = Object.defineProperties;
var styles_data = stylesName;
var ansiRegex = ansiRegex$1;
var ansiColors = styles_data.colors;
var ansiStyles = styles_data.styles;

var Colors = color$2.Colors;
var color$1 = color$2.color;

// Get all the color attribute.
ansiColors = Object.keys(color$1);

var styles = (function () {
  var ret = {};
  var retarr = ansiStyles.concat(ansiColors);
  retarr.forEach(function (key) {
    ret[key] = {
      get: function () {
        return build(this._styles.concat(key));
      }
    };
  });
  return ret;
})();

var proto = defineProps(function colors() {}, styles);


function build(_styles_more) {
  var builder = function builder() {
    return applyStyle.apply(builder, arguments);
  };
  builder._styles = _styles_more;
  // 使用它 __proto__ 是必须返回一个函数
  builder.__proto__ = proto;
  return builder;
}

function applyStyleCallback(str, _sty) {
  var _Colors = new Colors();
  for (var i = 0; i < _sty.length; i++) {
    _Colors.string = str;
    if (_sty[i]) str = _Colors[_sty[i]].valueOf(_sty[i]);
  }
  return str;
}

function regexReplace(str) {
  return str.replace(/(\[)/ig, '\\[').replace(/(\])/ig, '\\]');
}

// 应用 Ansi 样式
function applyStyle(){
  var args_len = arguments.length;
  var str = args_len !== 0 && String(arguments[0]);
  var _sty = this._styles;
  var ansiArray = str.match(ansiRegex());
  // 文本中是否带 ANSI 控制码
  if (ansiRegex().test(str) && ansiArray) {
    var leftReg = regexReplace(ansiArray[0]);
    var rightReg = regexReplace(ansiArray[ansiArray.length - 1]);
    var centerReg = new RegExp(leftReg + '(.*)' + rightReg, "g");
    var centerStr = str.match(centerReg);
    var sidesStr = str.split(centerStr);
    str = applyStyleCallback(sidesStr[0], _sty) + centerStr + applyStyleCallback(sidesStr[1], _sty);
  } else {
    str = applyStyleCallback(str, _sty);
  }
  return str;
}

function init() {
  var ret = {};
  Object.keys(styles).forEach(function (name) {
    ret[name] = {
      get: function () {
        return build([name]);
      }
    };
  });
  return ret;
}

defineProps(colors$1, init());

var colors = colorSafe;
var safe = colors;

var color = /*@__PURE__*/getDefaultExportFromCjs(safe);

const error = color.red.bold;

const flatDirectoryBlobAbi = [
    "constructor(uint8 slotLimit, uint32 maxChunkSize, address storageAddress) public",
    "function setDefault(bytes memory _defaultFile) public",
    "function upfrontPayment() external view returns (uint256)",
    "function getChunkHash(bytes memory name, uint256 chunkId) public view returns (bytes32)",
    "function writeChunks(bytes memory name, uint256[] memory chunkIds, uint256[] memory sizes) external payable",
    "function refund() public",
    "function remove(bytes memory name) external returns (uint256)",
    "function countChunks(bytes memory name) external view returns (uint256)",
    "function isSupportBlob() view public returns (bool)",
    "function getStorageMode(bytes memory name) public view returns(uint256)"
];

const REMOVE_FAIL = -1;
const REMOVE_NORMAL = 0;
const REMOVE_SUCCESS = 1;

const MAX_BLOB_COUNT = 3;

const VERSION_BLOB = '2';

const SEPOLIA_ETH_STORAGE = "0x804C520d3c084C805E37A35E90057Ac32831F96f";
const ES_TEST_RPC = "http://65.108.236.27:9540";

const stringToHex = (s) => ethers.ethers.hexlify(ethers.ethers.toUtf8Bytes(s));

function recursiveFiles(path, basePath) {
    let filePools = [];
    const fileStat = fs.statSync(path);
    if (fileStat.isFile()) {
        filePools.push({path: path, name: path.substring(path.lastIndexOf("/") + 1), size: fileStat.size});
        return filePools;
    }

    const files = fs.readdirSync(path);
    for (let file of files) {
        const fileStat = fs.statSync(`${path}/${file}`);
        if (fileStat.isDirectory()) {
            const pools = recursiveFiles(`${path}/${file}`, `${basePath}${file}/`);
            filePools = filePools.concat(pools);
        } else {
            filePools.push({path: `${path}/${file}`, name: `${basePath}${file}`, size: fileStat.size});
        }
    }
    return filePools;
}

class BaseEthStorage {
    #wallet;
    #blobUploader;
    #contractAddr;

    #mutex;
    #nonce;

    constructor(rpc, privateKey, contractAddr = null) {
        const provider = new ethers.ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.ethers.Wallet(privateKey, provider);
        this.#blobUploader = new BlobUploader(rpc, privateKey);
        this.#contractAddr = contractAddr;
        this.#mutex = new Mutex();
    }

    async deploy(ethStorage = "0x0000000000000000000000000000000000000000") {
        const contractByteCode = '0x60c0604052600060a09081526006906200001a9082620001ac565b503480156200002857600080fd5b50604051620038d0380380620038d08339810160408190526200004b9162000278565b60ff831660805282828281816200006233620000b5565b6002805463ffffffff909316600160a01b0263ffffffff60a01b1990931692909217909155600380546001600160a01b039092166001600160a01b031990921691909117905550620002e4945050505050565b600280546001600160a01b038381166001600160a01b0319831681179093556040519116919082907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a35050565b634e487b7160e01b600052604160045260246000fd5b600181811c908216806200013257607f821691505b6020821081036200015357634e487b7160e01b600052602260045260246000fd5b50919050565b601f821115620001a757600081815260208120601f850160051c81016020861015620001825750805b601f850160051c820191505b81811015620001a3578281556001016200018e565b5050505b505050565b81516001600160401b03811115620001c857620001c862000107565b620001e081620001d984546200011d565b8462000159565b602080601f831160018114620002185760008415620001ff5750858301515b600019600386901b1c1916600185901b178555620001a3565b600085815260208120601f198616915b82811015620002495788860151825594840194600190910190840162000228565b5085821015620002685787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b6000806000606084860312156200028e57600080fd5b835160ff81168114620002a057600080fd5b602085015190935063ffffffff81168114620002bb57600080fd5b60408501519092506001600160a01b0381168114620002d957600080fd5b809150509250925092565b6080516135c962000307600039600081816105500152611e9301526135c96000f3fe608060405260043610620001ee5760003560e01c8063590e1ae3116200010f578063caf1283611620000a3578063dd473fae116200006d578063dd473fae1462000776578063f14c7ad71462000794578063f2fde38b14620007ac578063f916c5b014620007d157620001ee565b8063caf1283614620006b5578063cf86bf9314620006f0578063d84eb56c146200072c578063dc38b0a2146200075157620001ee565b80638bf4515c11620000e55780638bf4515c14620006005780638da5cb5b146200062557806393b7628f1462000645578063956a3433146200069057620001ee565b8063590e1ae314620005ab5780635ba1d9e514620005c3578063715018a614620005e857620001ee565b80631ccbc6da116200018757806342216bed116200015d57806342216bed1462000504578063492c7b2a14620005295780634eed7cf1146200054057806358edef4c146200058657620001ee565b80631ccbc6da14620004ae5780631fbfa12714620004d55780632b68b9c614620004ec57620001ee565b806311ce026711620001c957806311ce026714620003de5780631a7237e014620004195780631c5ee10c146200044e5780631c993ad5146200048957620001ee565b8063038cd79f14620003705780630936286114620003895780631089f40f14620003b9575b348015620001fb57600080fd5b506000366060808284036200022157505060408051602081019091526000815262000365565b8383600081811062000237576200023762002a5f565b9050013560f81c60f81b6001600160f81b031916602f60f81b146200028357505060408051808201909152600e81526d0d2dcc6dee4e4cac6e840e0c2e8d60931b602082015262000365565b83836200029260018262002a8b565b818110620002a457620002a462002a5f565b909101356001600160f81b031916602f60f81b0390506200030657620002fd620002d2846001818862002aa1565b6006604051602001620002e89392919062002b03565b604051602081830303815290604052620007f6565b50905062000358565b6200035462000319846001818862002aa1565b8080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250620007f692505050565b5090505b6200036381620008a1565b505b915050805190602001f35b620003876200038136600462002ca3565b620008e2565b005b3480156200039657600080fd5b50620003a16200092c565b604051620003b0919062002d66565b60405180910390f35b348015620003c657600080fd5b5062000387620003d836600462002d7b565b620009c2565b348015620003eb57600080fd5b5060035462000400906001600160a01b031681565b6040516001600160a01b039091168152602001620003b0565b3480156200042657600080fd5b506200043e6200043836600462002da3565b62000a15565b604051620003b092919062002deb565b3480156200045b57600080fd5b50620004736200046d36600462002e11565b62000ac5565b60408051928352602083019190915201620003b0565b3480156200049657600080fd5b5062000387620004a836600462002e11565b62000b58565b348015620004bb57600080fd5b50620004c662000b97565b604051908152602001620003b0565b62000387620004e636600462002ed9565b62000c0d565b348015620004f957600080fd5b506200038762000d92565b3480156200051157600080fd5b50620004c66200052336600462002da3565b62000dcd565b620003876200053a36600462002f6a565b62000e78565b3480156200054d57600080fd5b507f000000000000000000000000000000000000000000000000000000000000000060ff1615155b6040519015158152602001620003b0565b3480156200059357600080fd5b50620004c6620005a536600462002e11565b62000f8f565b348015620005b857600080fd5b506200038762001057565b348015620005d057600080fd5b5062000575620005e236600462002da3565b620010c1565b348015620005f557600080fd5b506200038762001181565b3480156200060d57600080fd5b506200043e6200061f36600462002e11565b620007f6565b3480156200063257600080fd5b506002546001600160a01b031662000400565b3480156200065257600080fd5b50620006816200066436600462002e11565b805160209182012060009081526005909152604090205460ff1690565b604051620003b0919062002ff6565b3480156200069d57600080fd5b50620004c6620006af36600462003013565b620011bc565b348015620006c257600080fd5b50620006da620006d436600462002da3565b62001276565b60408051928352901515602083015201620003b0565b348015620006fd57600080fd5b506002546200071690600160a01b900463ffffffff1681565b60405163ffffffff9091168152602001620003b0565b3480156200073957600080fd5b50620004c66200074b36600462002da3565b6200130c565b3480156200075e57600080fd5b50620003876200077036600462003036565b620013c2565b3480156200078357600080fd5b50651b585b9d585b60d21b620004c6565b348015620007a157600080fd5b506200057562001411565b348015620007b957600080fd5b5062000387620007cb36600462003036565b6200143d565b348015620007de57600080fd5b50620004c6620007f036600462002e11565b620014dc565b60606000806200081d84805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000836576200083662002fe0565b0362000858576200084e848051906020012062001561565b9250925050915091565b60018160028111156200086f576200086f62002fe0565b0362000887576200084e848051906020012062001761565b505060408051600080825260208201909252939092509050565b600081516040620008b3919062003061565b9050601f19620008c582602062003061565b620008d290601f62003061565b1690506020808303528060208303f35b6002546001600160a01b03163314620009185760405162461bcd60e51b81526004016200090f9062003077565b60405180910390fd5b62000927836000848462000e78565b505050565b600680546200093b9062002acd565b80601f0160208091040260200160405190810160405280929190818152602001828054620009699062002acd565b8015620009ba5780601f106200098e57610100808354040283529160200191620009ba565b820191906000526020600020905b8154815290600101906020018083116200099c57829003601f168201915b505050505081565b6002546001600160a01b03163314620009ef5760405162461bcd60e51b81526004016200090f9062003077565b6002805463ffffffff909216600160a01b0263ffffffff60a01b19909216919091179055565b606060008062000a3c85805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000a555762000a5562002fe0565b0362000a795762000a6e8580519060200120856200188e565b925092505062000abe565b600181600281111562000a905762000a9062002fe0565b0362000aa95762000a6e8580519060200120856200196b565b50506040805160008082526020820190925291505b9250929050565b600080600062000aec84805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000b055762000b0562002fe0565b0362000b1d576200084e8480519060200120620019e4565b600181600281111562000b345762000b3462002fe0565b0362000b4c576200084e848051906020012062001abb565b50600093849350915050565b6002546001600160a01b0316331462000b855760405162461bcd60e51b81526004016200090f9062003077565b600662000b938282620030f6565b5050565b60035460408051630e65e36d60e11b815290516000926001600160a01b031691631ccbc6da9160048083019260209291908290030181865afa15801562000be2573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062000c089190620031c2565b905090565b6002546001600160a01b0316331462000c3a5760405162461bcd60e51b81526004016200090f9062003077565b62000c4462001411565b62000cab5760405162461bcd60e51b815260206004820152603060248201527f5468652063757272656e74206e6574776f726b20646f6573206e6f742073757060448201526f1c1bdc9d08189b1bd8881d5c1b1bd85960821b60648201526084016200090f565b600062000ccf84805160209182012060009081526005909152604090205460ff1690565b9050600081600281111562000ce85762000ce862002fe0565b148062000d095750600281600281111562000d075762000d0762002fe0565b145b62000d4e5760405162461bcd60e51b8152602060048201526014602482015273496e76616c69642073746f72616765206d6f646560601b60448201526064016200090f565b600081600281111562000d655762000d6562002fe0565b0362000d785762000d7884600262001b12565b62000d8c8480519060200120848462001b54565b50505050565b6002546001600160a01b0316331462000dbf5760405162461bcd60e51b81526004016200090f9062003077565b6002546001600160a01b0316ff5b60008062000df284805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000e0b5762000e0b62002fe0565b0362000e2d5762000e24848051906020012084620011bc565b91505062000e72565b600181600281111562000e445762000e4462002fe0565b0362000e6c57600062000e58858562000a15565b508051602090910120925062000e72915050565b50600090505b92915050565b6002546001600160a01b0316331462000ea55760405162461bcd60e51b81526004016200090f9062003077565b600062000ec985805160209182012060009081526005909152604090205460ff1690565b9050600081600281111562000ee25762000ee262002fe0565b148062000f035750600181600281111562000f015762000f0162002fe0565b145b62000f485760405162461bcd60e51b8152602060048201526014602482015273496e76616c69642073746f72616765206d6f646560601b60448201526064016200090f565b600081600281111562000f5f5762000f5f62002fe0565b0362000f725762000f7285600162001b12565b62000f8885805190602001208585853462001e83565b5050505050565b6002546000906001600160a01b0316331462000fbf5760405162461bcd60e51b81526004016200090f9062003077565b600062000fe383805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000ffc5762000ffc62002fe0565b036200101d57620010168380519060200120600062001f6c565b9392505050565b600181600281111562001034576200103462002fe0565b036200104e57620010168380519060200120600062001fcc565b50600092915050565b6002546001600160a01b03163314620010845760405162461bcd60e51b81526004016200090f9062003077565b6002546040516001600160a01b03909116904780156108fc02916000818181858888f19350505050158015620010be573d6000803e3d6000fd5b50565b6002546000906001600160a01b03163314620010f15760405162461bcd60e51b81526004016200090f9062003077565b60006200111584805160209182012060009081526005909152604090205460ff1690565b905060028160028111156200112e576200112e62002fe0565b03620011475762000e248480519060200120846200208e565b60018160028111156200115e576200115e62002fe0565b03620011775762000e2484805190602001208462002116565b5060009392505050565b6002546001600160a01b03163314620011ae5760405162461bcd60e51b81526004016200090f9062003077565b620011ba600062002206565b565b6000620011c98362002258565b8210620011d95750600062000e72565b60035460008481526004602081815260408084208785529091529182902054915163d8389dc560e01b8152908101919091526001600160a01b039091169063d8389dc590602401602060405180830381865afa1580156200123e573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190620012649190620031dc565b67ffffffffffffffff19169392505050565b60008060006200129d85805160209182012060009081526005909152604090205460ff1690565b90506002816002811115620012b657620012b662002fe0565b03620012cf5762000a6e85805190602001208562002299565b6001816002811115620012e657620012e662002fe0565b03620012ff5762000a6e8580519060200120856200234d565b5060009485945092505050565b6002546000906001600160a01b031633146200133c5760405162461bcd60e51b81526004016200090f9062003077565b60006200136084805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562001379576200137962002fe0565b03620013925762000e2484805190602001208462001f6c565b6001816002811115620013a957620013a962002fe0565b03620011775762000e2484805190602001208462001fcc565b6002546001600160a01b03163314620013ef5760405162461bcd60e51b81526004016200090f9062003077565b600380546001600160a01b0319166001600160a01b0392909216919091179055565b6003546000906001600160a01b03161580159062000c08575060006200143662000b97565b1015905090565b6002546001600160a01b031633146200146a5760405162461bcd60e51b81526004016200090f9062003077565b6001600160a01b038116620014d15760405162461bcd60e51b815260206004820152602660248201527f4f776e61626c653a206e6577206f776e657220697320746865207a65726f206160448201526564647265737360d01b60648201526084016200090f565b620010be8162002206565b6000806200150183805160209182012060009081526005909152604090205460ff1690565b905060028160028111156200151a576200151a62002fe0565b03620015325762001016838051906020012062002258565b600181600281111562001549576200154962002fe0565b036200104e57620010168380519060200120620023a5565b606060008060006200157385620019e4565b9150915080600003620015bb5760005b6040519080825280601f01601f191660200182016040528015620015ae576020820181803683370190505b5095600095509350505050565b6000826001600160401b03811115620015d857620015d862002b90565b6040519080825280601f01601f19166020018201604052801562001603576020820181803683370190505b5090506000805b838110156200175257600088815260046020818152604080842085855290915280832054600354915163afd5644d60e01b815292830181905292916001600160a01b039091169063afd5644d90602401602060405180830381865afa15801562001678573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906200169e9190620031c2565b60035460405163bea94b8b60e01b81529192506001600160a01b03169063bea94b8b90620016d9908590600190600090879060040162003209565b600060405180830381865afa158015620016f7573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f191682016040526200172191908101906200323e565b508060406020868801013e62001738818562003061565b9350505080806200174990620032bd565b9150506200160a565b50909660019650945050505050565b60606000806000620017738562001abb565b91509150806000036200178857600062001583565b6000826001600160401b03811115620017a557620017a562002b90565b6040519080825280601f01601f191660200182016040528015620017d0576020820181803683370190505b5090506020810160005b838110156200175257600088815260208181526040808320848452909152812054906200180782620023e4565b156200184957620018188260e01c90565b60008b8152600160209081526040808320878452909152902090915062001841908386620023f9565b505062001868565b816200185581620024ad565b50915062001864818662002513565b5050505b62001874818562003061565b9350505080806200188590620032bd565b915050620017da565b60606000806200189f858562002299565b5090506001811015620018c657505060408051600080825260208201909252915062000abe565b600354600086815260046020818152604080842089855290915280832054905163bea94b8b60e01b815292936001600160a01b03169263bea94b8b92620019169291600191879189910162003209565b600060405180830381865afa15801562001934573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f191682016040526200195e91908101906200323e565b9660019650945050505050565b600082815260208181526040808320848452909152812054606091906200199281620023e4565b15620019cc5760008581526001602090815260408083208784529091528120620019bd908362002572565b93506001925062000abe915050565b80620019d88162002619565b93509350505062000abe565b6000806000620019f48462002258565b90506000805b8281101562001ab15760035460008781526004602081815260408084208685529091529182902054915163afd5644d60e01b8152908101919091526001600160a01b039091169063afd5644d90602401602060405180830381865afa15801562001a68573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062001a8e9190620031c2565b62001a9a908362003061565b91508062001aa881620032bd565b915050620019fa565b5094909350915050565b6000806000805b60008062001ad187846200234d565b915091508062001ae357505062001b08565b62001aef828562003061565b93508262001afd81620032bd565b935050505062001ac2565b9094909350915050565b81516020808401919091206000908152600590915260409020805482919060ff1916600183600281111562001b4b5762001b4b62002fe0565b02179055505050565b815160035460408051630e65e36d60e11b815290516000926001600160a01b031691631ccbc6da9160048083019260209291908290030181865afa15801562001ba1573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062001bc79190620031c2565b905062001bd58282620032d9565b34101562001c1d5760405162461bcd60e51b8152602060048201526014602482015273696e73756666696369656e742062616c616e636560601b60448201526064016200090f565b60005b828160ff16101562001e7b57838160ff168151811062001c445762001c4462002a5f565b6020026020010151600010801562001c935750600260149054906101000a900463ffffffff1663ffffffff16848260ff168151811062001c885762001c8862002a5f565b602002602001015111155b62001cd85760405162461bcd60e51b81526020600482015260146024820152730d2dcecc2d8d2c840c6d0eadcd640d8cadccee8d60631b60448201526064016200090f565b62001d0386868360ff168151811062001cf55762001cf562002a5f565b6020026020010151620026bf565b60003387878460ff168151811062001d1f5762001d1f62002a5f565b602002602001015160405160200162001d56939291906001600160a01b039390931683526020830191909152604082015260600190565b604051602081830303815290604052805190602001209050600360009054906101000a90046001600160a01b03166001600160a01b0316634581a920848385898760ff168151811062001dad5762001dad62002a5f565b60200260200101516040518563ffffffff1660e01b815260040162001de89392919092835260ff919091166020830152604082015260600190565b6000604051808303818588803b15801562001e0257600080fd5b505af115801562001e17573d6000803e3d6000fd5b505050505080600460008981526020019081526020016000206000888560ff168151811062001e4a5762001e4a62002a5f565b602002602001015181526020019081526020016000208190555050808062001e7290620032f3565b91505062001c20565b505050505050565b62001e8f85856200275d565b60ff7f00000000000000000000000000000000000000000000000000000000000000001682111562001ef65762001ed862001ecc84848462002875565b6001600160a01b031690565b60008681526020818152604080832088845290915290205562000f88565b60008581526001602090815260408083208784528252918290208251601f860183900483028101830190935284835262001f4d92909186908690819084018382808284376000920191909152506200293192505050565b6000868152602081815260408083208884529091529020555050505050565b60005b60008381526004602090815260408083208584529091529020548062001f96575062001fc6565b60008481526004602090815260408083208684529091528120558262001fbc81620032bd565b9350505062001f6f565b50919050565b60005b6000838152602081815260408083208584529091529020548062001ff4575062001fc6565b62001fff81620023e4565b62002060576000819050806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b1580156200204557600080fd5b505af11580156200205a573d6000803e3d6000fd5b50505050505b600084815260208181526040808320868452909152812055826200208481620032bd565b9350505062001fcf565b600082815260046020908152604080832084845290915281205480620020b957600091505062000e72565b600084815260046020526040812081620020d586600162003061565b81526020019081526020016000205414620020f557600091505062000e72565b50506000918252600460209081526040808420928452919052812055600190565b600082815260208181526040808320848452909152812054806200213f57600091505062000e72565b6000848152602081905260408120816200215b86600162003061565b815260200190815260200160002054146200217b57600091505062000e72565b6200218681620023e4565b620021e7576000819050806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b158015620021cc57600080fd5b505af1158015620021e1573d6000803e3d6000fd5b50505050505b5050600091825260208281526040808420928452919052812055600190565b600280546001600160a01b038381166001600160a01b0319831681179093556040519116919082907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a35050565b6000805b60008381526004602090815260408083208484529091529020548062002283575062000e72565b816200228f81620032bd565b925050506200225c565b600080620022a78462002258565b8310620022ba5750600090508062000abe565b600354600085815260046020818152604080842088855290915280832054905163afd5644d60e01b81529182015290916001600160a01b03169063afd5644d90602401602060405180830381865afa1580156200231b573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190620023419190620031c2565b95600195509350505050565b6000828152602081815260408083208484529091528120548190806200237b57600080925092505062000abe565b6200238681620023e4565b1562002399576000620019bd8260e01c90565b80620019d881620024ad565b6000805b60008381526020818152604080832084845290915290205480620023ce575062000e72565b81620023da81620032bd565b92505050620023a9565b600080620023f28360e01c90565b1192915050565b60008060006200240985620029cb565b808652909350905083601c8411156200249f57601c81016000805b6020600162002435601c8a62002a8b565b6200244290602062003061565b6200244e919062002a8b565b6200245a919062003315565b8110156200249b57600081815260208b815260409091205480855292506200248490849062003061565b9250806200249281620032bd565b91505062002424565b5050505b600192505050935093915050565b6000806001600160a01b038316620024ca57506000928392509050565b60008060405180610160016040528061012681526020016200346e6101269139519050843b91508082101562002507575060009485945092505050565b62002341818362002a8b565b6000806000806200252486620024ad565b91509150806200253d5760008093509350505062000abe565b600060405180610160016040528061012681526020016200346e6101269139519050828187893c509095600195509350505050565b606060006200258183620029e6565b92509050601c8111156200261257603c82016000805b60206001620025a8601c8762002a8b565b620025b590602062003061565b620025c1919062002a8b565b620025cd919062003315565b8110156200260e57600081815260208881526040909120548085529250620025f790849062003061565b9250806200260581620032bd565b91505062002597565b5050505b5092915050565b606060008060006200262b85620024ad565b91509150806200263d57600062001583565b6000826001600160401b038111156200265a576200265a62002b90565b6040519080825280601f01601f19166020018201604052801562002685576020820181803683370190505b509050600060405180610160016040528061012681526020016200346e6101269139519050838160208401893c5095600195509350505050565b60008281526004602090815260408083208484529091529020548062000927578115806200271657506000838152600460205260408120816200270460018662002a8b565b81526020019081526020016000205414155b620009275760405162461bcd60e51b81526020600482015260166024820152751b5d5cdd081c995c1b1858d9481bdc88185c1c195b9960521b60448201526064016200090f565b60008281526020818152604080832084845290915290205480620027f957811580620027b25750600083815260208190526040812081620027a060018662002a8b565b81526020019081526020016000205414155b620027f95760405162461bcd60e51b81526020600482015260166024820152751b5d5cdd081c995c1b1858d9481bdc88185c1c195b9960521b60448201526064016200090f565b6200280481620023e4565b6200092757806001600160a01b0381161562000d8c57806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b1580156200285657600080fd5b505af11580156200286b573d6000803e3d6000fd5b5050505050505050565b60008060405180610160016040528061012681526020016200346e61012691398585604051602001620028ab9392919062003338565b60408051601f1981840301815291905290506000620028cd6043602062003061565b30838201529050620028e2608c602062003061565b905030818301525060008382604051620028fc9062002a51565b62002908919062002d66565b6040518091039082f090508015801562002926573d6000803e3d6000fd5b509695505050505050565b805160208083015160e083901b911c1790601c81111562002612576000603c8401815b6020600162002965601c8762002a8b565b6200297290602062003061565b6200297e919062002a8b565b6200298a919062003315565b8110156200260e5781519250620029a382602062003061565b6000828152602089905260409020849055915080620029c281620032bd565b91505062002954565b600080620029d98360e01c90565b9360209390931b92915050565b60006060620029f58360e01c90565b9150602083901b9250816001600160401b0381111562002a195762002a1962002b90565b6040519080825280601f01601f19166020018201604052801562002a44576020820181803683370190505b5060208101939093525091565b61010b806200336383390190565b634e487b7160e01b600052603260045260246000fd5b634e487b7160e01b600052601160045260246000fd5b8181038181111562000e725762000e7262002a75565b6000808585111562002ab257600080fd5b8386111562002ac057600080fd5b5050820193919092039150565b600181811c9082168062002ae257607f821691505b60208210810362001fc657634e487b7160e01b600052602260045260246000fd5b828482376000838201600081526000845462002b1f8162002acd565b6001828116801562002b3a576001811462002b505762002b81565b60ff198416865282151583028601945062002b81565b8860005260208060002060005b8581101562002b785781548982015290840190820162002b5d565b50505082860194505b50929998505050505050505050565b634e487b7160e01b600052604160045260246000fd5b604051601f8201601f191681016001600160401b038111828210171562002bd15762002bd162002b90565b604052919050565b60006001600160401b0382111562002bf55762002bf562002b90565b50601f01601f191660200190565b600082601f83011262002c1557600080fd5b813562002c2c62002c268262002bd9565b62002ba6565b81815284602083860101111562002c4257600080fd5b816020850160208301376000918101602001919091529392505050565b60008083601f84011262002c7257600080fd5b5081356001600160401b0381111562002c8a57600080fd5b60208301915083602082850101111562000abe57600080fd5b60008060006040848603121562002cb957600080fd5b83356001600160401b038082111562002cd157600080fd5b62002cdf8783880162002c03565b9450602086013591508082111562002cf657600080fd5b5062002d058682870162002c5f565b9497909650939450505050565b60005b8381101562002d2f57818101518382015260200162002d15565b50506000910152565b6000815180845262002d5281602086016020860162002d12565b601f01601f19169290920160200192915050565b60208152600062001016602083018462002d38565b60006020828403121562002d8e57600080fd5b813563ffffffff811681146200101657600080fd5b6000806040838503121562002db757600080fd5b82356001600160401b0381111562002dce57600080fd5b62002ddc8582860162002c03565b95602094909401359450505050565b60408152600062002e00604083018562002d38565b905082151560208301529392505050565b60006020828403121562002e2457600080fd5b81356001600160401b0381111562002e3b57600080fd5b62002e498482850162002c03565b949350505050565b600082601f83011262002e6357600080fd5b813560206001600160401b0382111562002e815762002e8162002b90565b8160051b62002e9282820162002ba6565b928352848101820192828101908785111562002ead57600080fd5b83870192505b8483101562002ece5782358252918301919083019062002eb3565b979650505050505050565b60008060006060848603121562002eef57600080fd5b83356001600160401b038082111562002f0757600080fd5b62002f158783880162002c03565b9450602086013591508082111562002f2c57600080fd5b62002f3a8783880162002e51565b9350604086013591508082111562002f5157600080fd5b5062002f608682870162002e51565b9150509250925092565b6000806000806060858703121562002f8157600080fd5b84356001600160401b038082111562002f9957600080fd5b62002fa78883890162002c03565b955060208701359450604087013591508082111562002fc557600080fd5b5062002fd48782880162002c5f565b95989497509550505050565b634e487b7160e01b600052602160045260246000fd5b60208101600383106200300d576200300d62002fe0565b91905290565b600080604083850312156200302757600080fd5b50508035926020909101359150565b6000602082840312156200304957600080fd5b81356001600160a01b03811681146200101657600080fd5b8082018082111562000e725762000e7262002a75565b6020808252818101527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604082015260600190565b601f8211156200092757600081815260208120601f850160051c81016020861015620030d55750805b601f850160051c820191505b8181101562001e7b57828155600101620030e1565b81516001600160401b0381111562003112576200311262002b90565b6200312a8162003123845462002acd565b84620030ac565b602080601f831160018114620031625760008415620031495750858301515b600019600386901b1c1916600185901b17855562001e7b565b600085815260208120601f198616915b82811015620031935788860151825594840194600190910190840162003172565b5085821015620031b25787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b600060208284031215620031d557600080fd5b5051919050565b600060208284031215620031ef57600080fd5b815167ffffffffffffffff19811681146200101657600080fd5b848152608081016002851062003223576200322362002fe0565b84602083015283604083015282606083015295945050505050565b6000602082840312156200325157600080fd5b81516001600160401b038111156200326857600080fd5b8201601f810184136200327a57600080fd5b80516200328b62002c268262002bd9565b818152856020838501011115620032a157600080fd5b620032b482602083016020860162002d12565b95945050505050565b600060018201620032d257620032d262002a75565b5060010190565b808202811582820484141762000e725762000e7262002a75565b600060ff821660ff81036200330c576200330c62002a75565b60010192915050565b6000826200333357634e487b7160e01b600052601260045260246000fd5b500490565b600084516200334c81846020890162002d12565b820183858237600093019283525090939250505056fe608060405260405161010b38038061010b83398101604081905261002291610041565b80518060208301f35b634e487b7160e01b600052604160045260246000fd5b6000602080838503121561005457600080fd5b82516001600160401b038082111561006b57600080fd5b818501915085601f83011261007f57600080fd5b8151818111156100915761009161002b565b604051601f8201601f19908116603f011681019083821181831017156100b9576100b961002b565b8160405282815288868487010111156100d157600080fd5b600093505b828410156100f357848401860151818501870152928501926100d6565b60008684830101528096505050505050509291505056fe6080604052348015600f57600080fd5b506004361060325760003560e01c80632b68b9c61460375780638da5cb5b14603f575b600080fd5b603d6081565b005b60657f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b03909116815260200160405180910390f35b336001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000161460ed5760405162461bcd60e51b815260206004820152600e60248201526d3737ba10333937b69037bbb732b960911b604482015260640160405180910390fd5b33fffea2646970667358221220fc66c9afb7cb2f6209ae28167cf26c6c06f86a82cbe3c56de99027979389a1be64736f6c63430008070033a264697066735822122074ecdb7c1356cd26b7ae20a002751e685b2c97645c0ec1b1214c316ec9516dce64736f6c63430008120033';
        const factory = new ethers.ethers.ContractFactory(flatDirectoryBlobAbi, contractByteCode, this.#wallet);
        try {
            const contract = await factory.deploy(0, BLOB_DATA_SIZE, ethStorage, {gasLimit: 3800000});
            await contract.waitForDeployment();

            this.#contractAddr = await contract.getAddress();
            console.log(`FlatDirectory Address: ${this.#contractAddr}`);
            return this.#contractAddr;
        } catch (e) {
            console.error(`ERROR: deploy flat directory failed!`, e.message);
            return null;
        }
    }

    async deploySepolia() {
        return this.deploy(SEPOLIA_ETH_STORAGE);
    }

    async setDefault(filename) {
        if (!this.#contractAddr) {
            console.error(`ERROR: flat directory not deployed!`);
            return;
        }

        const hexName = filename ? stringToHex(filename) : "0x";
        const fileContract = new ethers.ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
        try {
            const tx = await fileContract.setDefault(hexName);
            console.log(`Transaction Id: ${tx.hash}`);
            const txReceipt = await tx.wait();
            if (txReceipt.status) {
                console.log(`Set succeeds`);
            } else {
                console.error(`ERROR: set failed!`);
            }
        } catch (e) {
            console.error(`ERROR: set failed!`, e.message);
        }
    }

    async refund() {
        if (!this.#contractAddr) {
            console.error(`ERROR: flat directory not deployed!`);
            return;
        }

        const fileContract = new ethers.ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
        try {
            const tx = await fileContract.refund();
            console.log(`Transaction Id: ${tx.hash}`);
            const txReceipt = await tx.wait();
            if (txReceipt.status) {
                console.log(`Refund succeeds`);
            } else {
                console.error(`ERROR: transaction failed!`);
            }
        } catch (e) {
            console.error(`ERROR: transaction failed!`, e.message);
        }
    }

    async remove(fileName) {
        return await this.#remove(fileName, undefined);
    }

    async #remove(fileName, nonce) {
        const fileContract = new ethers.ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
        try {
            const tx = await fileContract.remove(stringToHex(fileName), {
                nonce: nonce
            });
            console.log(`Transaction Id: ${tx.hash}`);
            const receipt = await tx.wait();
            if (receipt.status) {
                console.log(`Remove file: ${fileName} succeeded`);
                return true;
            } else {
                console.error(`ERROR: Failed to remove file: ${fileName}`);
            }
        } catch (e) {
            console.error(`ERROR: Failed to remove file: ${fileName}`, e.message);
        }
        return false;
    }

    async download(fileName, ethStorageRpc = ES_TEST_RPC) {
        if (!this.#contractAddr) {
            console.error(`ERROR: flat directory not deployed!`);
            return;
        }
        return await Download(ethStorageRpc, this.#contractAddr, fileName);
    }

    // ******upload data******* /
    async #clearOldFile(fileName, chunkLength, oldChunkLength) {
        if (oldChunkLength > chunkLength) {
            // remove
            const v = await this.#remove(fileName, this.#increasingNonce());
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

    async uploadData(fileName, data) {
        if (!this.#contractAddr) {
            throw new Error(`ERROR: flat directory not deployed!`);
        }

        const hexName = stringToHex(fileName);
        const content = Buffer.from(data);
        const fileSize = content.length;

        const fileContract = new ethers.ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
        const [isSupport, cost, oldChunkLength, fileMod] = await Promise.all([
            fileContract.isSupportBlob(),
            fileContract.upfrontPayment(),
            fileContract.countChunks(hexName),
            fileContract.getStorageMode(hexName)
        ]);
        if (!isSupport) {
            throw new Error(`ERROR: The current contract does not support blob upload!`);
        }
        if (fileMod !== BigInt(VERSION_BLOB) && fileMod !== 0n) {
            throw new Error(`ERROR: This file does not support blob upload! file=${fileName}`);
        }

        const blobs = EncodeBlobs(content);
        const blobLength = blobs.length;
        const blobDataSize = BLOB_DATA_SIZE;
        // check old data
        const clearState = await this.#clearOldFile(fileName, blobLength, oldChunkLength);
        if (clearState === REMOVE_FAIL) {
            throw new Error(`ERROR: Failed to delete old data!`);
        }

        // send
        await this.#initNonce();
        let currentSuccessIndex = -1;
        let totalUploadCount = 0;
        let totalUploadSize = 0;
        let totalCost = 0n;
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const blobArr = [];
            const chunkIdArr = [];
            const chunkSizeArr = [];
            let max = i + MAX_BLOB_COUNT > blobLength ? blobLength : i + MAX_BLOB_COUNT;
            for (let j = i; j < max; j++) {
                blobArr.push(blobs[j]);
                chunkIdArr.push(j);
                if (j === blobLength - 1) {
                    chunkSizeArr.push(fileSize - blobDataSize * (blobLength - 1));
                } else {
                    chunkSizeArr.push(blobDataSize);
                }
            }

            const result = await this.#uploadBlob(fileContract, fileName, hexName, clearState, blobArr, chunkIdArr, chunkSizeArr, cost);
            if(!result.isSuccess) {
                break; //  fail
            }

            if (result.totalUploadSize === 0) {
                currentSuccessIndex += blobArr.length;
            } else {
                totalCost += result.totalCost;
                totalUploadSize += result.totalUploadSize;
                totalUploadCount += blobArr.length;
                currentSuccessIndex += blobArr.length;
            }
        }
        return {
            fileName: fileName,
            totalChunkCount: blobLength,
            currentSuccessIndex: currentSuccessIndex,
            totalUploadCount: totalUploadCount,
            totalUploadSize: totalUploadSize,
            totalCost: totalCost,
        }
    }

    async upload(fileOrPath, syncPoolSize = 15) {
        if (!this.#contractAddr) {
            throw new Error(`ERROR: flat directory not deployed!`);
        }

        const fileContract = new ethers.ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
        const isSupport = fileContract.isSupportBlob();
        if (!isSupport) {
            throw new Error(`ERROR: The current contract does not support blob upload!`);
        }

        // upload file
        return await this.#uploadFiles(fileOrPath, syncPoolSize);
    }

    async #initNonce() {
        this.#nonce = await this.#blobUploader.getNonce();
        console.log("Init nonce success: nonce is", this.#nonce);
        return this.#nonce;
    }

    #increasingNonce() {
        return this.#nonce++;
    }

    async #uploadFiles(filePath, syncPoolSize) {
        await this.#initNonce();
        const results = [];
        return new Promise((resolve) => {
            from(recursiveFiles(filePath, ''))
                .pipe(mergeMap(info => this.#uploadFile(info), syncPoolSize))
                .subscribe({
                    next: (info) => { results.push(info); },
                    error: (error) => { throw error },
                    complete: () => { resolve(results); }
                });
        });
    }

    async #uploadFile(fileInfo) {
        const fileSize = fileInfo.size;
        const fileName = fileInfo.name;
        const hexName = stringToHex(fileName);

        const fileContract = new ethers.ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
        const [cost, oldChunkLength, fileMod] = await Promise.all([
            fileContract.upfrontPayment(),
            fileContract.countChunks(hexName),
            fileContract.getStorageMode(hexName)
        ]);
        if (fileMod !== BigInt(VERSION_BLOB) && fileMod !== 0n) {
            console.log(error(`ERROR: This file does not support blob upload! file=${fileName}`));
            return {status: 0, fileName: fileName};
        }

        const blobDataSize = BLOB_DATA_SIZE;
        const blobLength = Math.ceil(fileSize / blobDataSize);
        // check old data
        const clearState = await this.#clearOldFile(fileName, blobLength, oldChunkLength);
        if (clearState === REMOVE_FAIL) {
            console.log(error(`ERROR: Failed to delete old data! file=${fileName}`));
            return {status: 0, fileName: fileName};
        }

        // upload
        let currentSuccessIndex = -1;
        let totalUploadCount = 0;
        let totalUploadSize = 0;
        let totalCost = 0n;
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const content = await this.getFileChunk(fileInfo.path, fileSize, i * blobDataSize, (i + MAX_BLOB_COUNT) * blobDataSize);
            const blobs = EncodeBlobs(content);
            const chunkIdArr = [];
            const chunkSizeArr = [];
            for (let j = 0; j < blobs.length; j++) {
                chunkIdArr.push(i + j);
                if (i + j === blobLength - 1) {
                    // last blob
                    chunkSizeArr.push(fileSize - blobDataSize * (blobLength - 1));
                } else {
                    chunkSizeArr.push(blobDataSize);
                }
            }

            const result = await this.#uploadBlob(fileContract, fileName, hexName, clearState, blobs, chunkIdArr, chunkSizeArr, cost);
            if(!result.isSuccess) {
                break; //  fail
            }

            if (result.totalUploadSize === 0) {
                // not change
                currentSuccessIndex += blobs.length;
            } else {
                totalCost += result.totalCost;
                totalUploadSize += result.totalUploadSize;
                totalUploadCount += blobs.length;
                currentSuccessIndex += blobs.length;
            }
        }
        return {
            status: 1,
            fileName: fileName,
            totalChunkCount: blobLength,
            currentSuccessIndex: currentSuccessIndex,
            totalUploadCount: totalUploadCount,
            totalUploadSize: totalUploadSize / 1024,
            totalCost: totalCost,
        }
    }

    async #uploadBlob(fileContract, fileName, hexName, clearState, blobs, chunkIdArr, chunkSizeArr, cost) {
        try {
            // check
            if (clearState === REMOVE_NORMAL) {
                let hasChange = false;
                for (let j = 0; j < blobs.length; j++) {
                    const dataHash = await fileContract.getChunkHash(hexName, chunkIdArr[j]);
                    const localHash = await this.#blobUploader.getBlobHash(blobs[j]);
                    if (dataHash !== localHash) {
                        hasChange = true;
                        break;
                    }
                }
                if (!hasChange) {
                    console.log(`File ${fileName} chunkId: ${chunkIdArr}: The data is not changed.`);
                    return {
                        isSuccess: true,
                        totalUploadSize: 0,
                    }
                }
            }

            // create tx
            const value = cost * BigInt(blobs.length);
            const tx = await fileContract.writeChunks.populateTransaction(hexName, chunkIdArr, chunkSizeArr, {value});
            const [maxFeePerBlobGas, gasFeeData] = await Promise.all([
                this.#blobUploader.getBlobGasPrice(),
                this.#blobUploader.getGasPrice(),
            ]);
            tx.maxFeePerBlobGas = maxFeePerBlobGas * 6n / 5n;
            tx.maxFeePerGas = gasFeeData.maxFeePerGas * 6n / 5n;
            tx.maxPriorityFeePerGas = gasFeeData.maxPriorityFeePerGas * 6n / 5n;
            tx.gasLimit = 1000000n;

            // send
            const txResponse = await this.#send(fileName, tx, blobs, chunkIdArr);
            const txReceipt = await txResponse.wait();
            if (txReceipt && txReceipt.status) {
                console.log(`File ${fileName} chunkId: ${chunkIdArr} uploaded!`);
                let totalUploadSize = 0;
                for (let i = 0; i < chunkSizeArr.length; i++) {
                    totalUploadSize += chunkSizeArr[i];
                }
                return {
                    isSuccess: true,
                    totalUploadSize: totalUploadSize,
                    totalCost: value,
                }
            }
        } catch (e) {
            const length = e.message.length;
            console.log(length > 210 ? (e.message.substring(0, 100) + " ... " + e.message.substring(length - 100, length)) : e.message);
            console.log(error(`ERROR: upload ${fileName} fail!`));
        }
        return {
            isSuccess: false,
        }
    }

    async #send(fileName, tx, blobs, chunkIdArr) {
        const release = await this.#mutex.acquire();
        try {
            // lock
            tx.nonce = this.#increasingNonce();
            const txRes = await this.#blobUploader.sendTx(tx, blobs);
            console.log(`Send Success: File: ${fileName}, Chunk Id: ${chunkIdArr}, Transaction hash: ${txRes.hash}`);
            return txRes;
        } finally {
            // unlock
            release();
        }
    }

    getFileInfo(filePath) {}
    async getFileChunk(filePath, fileSize, start, end) {}
}

class EthStorage extends BaseEthStorage{
    getFileInfo(filePath) {
        const fileStat = fs.statSync(filePath);
        if (fileStat.isFile()) {
            const name = filePath.substring(filePath.lastIndexOf("/") + 1);
            return {
                isFile: true,
                isDirectory: false,
                name: name,
                size: fileStat.size,
                path: filePath
            };
        }
        return {
            isFile: false,
            isDirectory: fileStat.isDirectory()
        };
    }

    async getFileChunk(filePath, fileSize, start, end) {
        end = end > fileSize ? fileSize : end;
        const length = end - start;
        const buf = Buffer.alloc(length);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buf, 0, length, start);
        fs.closeSync(fd);
        return buf;
    }
}

exports.BLOB_DATA_SIZE = BLOB_DATA_SIZE;
exports.BLOB_SIZE = BLOB_SIZE;
exports.BlobUploader = BlobUploader;
exports.DecodeBlob = DecodeBlob;
exports.DecodeBlobs = DecodeBlobs;
exports.Download = Download;
exports.EncodeBlobs = EncodeBlobs;
exports.EthStorage = EthStorage;
//# sourceMappingURL=index.cjs.js.map
