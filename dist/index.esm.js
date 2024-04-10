import { ethers, Contract } from 'ethers';
import { EventEmitter } from 'events';
import { loadKZG } from 'kzg-wasm';

/**
 * RLP Encoding based on https://ethereum.org/en/developers/docs/data-structures-and-encoding/rlp/
 * This function takes in data, converts it to Uint8Array if not,
 * and adds a length for recursion.
 * @param input Will be converted to Uint8Array
 * @returns Uint8Array of encoded data
 **/
function encode(input) {
    if (Array.isArray(input)) {
        const output = [];
        let outputLength = 0;
        for (let i = 0; i < input.length; i++) {
            const encoded = encode(input[i]);
            output.push(encoded);
            outputLength += encoded.length;
        }
        return concatBytes$3(encodeLength(outputLength, 192), ...output);
    }
    const inputBuf = toBytes$2(input);
    if (inputBuf.length === 1 && inputBuf[0] < 128) {
        return inputBuf;
    }
    return concatBytes$3(encodeLength(inputBuf.length, 128), inputBuf);
}
/**
 * Slices a Uint8Array, throws if the slice goes out-of-bounds of the Uint8Array.
 * E.g. `safeSlice(hexToBytes('aa'), 1, 2)` will throw.
 * @param input
 * @param start
 * @param end
 */
function safeSlice(input, start, end) {
    if (end > input.length) {
        throw new Error('invalid RLP (safeSlice): end slice of Uint8Array out-of-bounds');
    }
    return input.slice(start, end);
}
/**
 * Parse integers. Check if there is no leading zeros
 * @param v The value to parse
 */
function decodeLength(v) {
    if (v[0] === 0) {
        throw new Error('invalid RLP: extra zeros');
    }
    return parseHexByte(bytesToHex$2(v));
}
function encodeLength(len, offset) {
    if (len < 56) {
        return Uint8Array.from([len + offset]);
    }
    const hexLength = numberToHex(len);
    const lLength = hexLength.length / 2;
    const firstByte = numberToHex(offset + 55 + lLength);
    return Uint8Array.from(hexToBytes$2(firstByte + hexLength));
}
function decode(input, stream = false) {
    if (typeof input === 'undefined' || input === null || input.length === 0) {
        return Uint8Array.from([]);
    }
    const inputBytes = toBytes$2(input);
    const decoded = _decode(inputBytes);
    if (stream) {
        return {
            data: decoded.data,
            remainder: decoded.remainder.slice(),
        };
    }
    if (decoded.remainder.length !== 0) {
        throw new Error('invalid RLP: remainder must be zero');
    }
    return decoded.data;
}
/** Decode an input with RLP */
function _decode(input) {
    let length, llength, data, innerRemainder, d;
    const decoded = [];
    const firstByte = input[0];
    if (firstByte <= 0x7f) {
        // a single byte whose value is in the [0x00, 0x7f] range, that byte is its own RLP encoding.
        return {
            data: input.slice(0, 1),
            remainder: input.subarray(1),
        };
    }
    else if (firstByte <= 0xb7) {
        // string is 0-55 bytes long. A single byte with value 0x80 plus the length of the string followed by the string
        // The range of the first byte is [0x80, 0xb7]
        length = firstByte - 0x7f;
        // set 0x80 null to 0
        if (firstByte === 0x80) {
            data = Uint8Array.from([]);
        }
        else {
            data = safeSlice(input, 1, length);
        }
        if (length === 2 && data[0] < 0x80) {
            throw new Error('invalid RLP encoding: invalid prefix, single byte < 0x80 are not prefixed');
        }
        return {
            data,
            remainder: input.subarray(length),
        };
    }
    else if (firstByte <= 0xbf) {
        // string is greater than 55 bytes long. A single byte with the value (0xb7 plus the length of the length),
        // followed by the length, followed by the string
        llength = firstByte - 0xb6;
        if (input.length - 1 < llength) {
            throw new Error('invalid RLP: not enough bytes for string length');
        }
        length = decodeLength(safeSlice(input, 1, llength));
        if (length <= 55) {
            throw new Error('invalid RLP: expected string length to be greater than 55');
        }
        data = safeSlice(input, llength, length + llength);
        return {
            data,
            remainder: input.subarray(length + llength),
        };
    }
    else if (firstByte <= 0xf7) {
        // a list between 0-55 bytes long
        length = firstByte - 0xbf;
        innerRemainder = safeSlice(input, 1, length);
        while (innerRemainder.length) {
            d = _decode(innerRemainder);
            decoded.push(d.data);
            innerRemainder = d.remainder;
        }
        return {
            data: decoded,
            remainder: input.subarray(length),
        };
    }
    else {
        // a list over 55 bytes long
        llength = firstByte - 0xf6;
        length = decodeLength(safeSlice(input, 1, llength));
        if (length < 56) {
            throw new Error('invalid RLP: encoded list too short');
        }
        const totalLength = llength + length;
        if (totalLength > input.length) {
            throw new Error('invalid RLP: total length is larger than the data');
        }
        innerRemainder = safeSlice(input, llength, totalLength);
        while (innerRemainder.length) {
            d = _decode(innerRemainder);
            decoded.push(d.data);
            innerRemainder = d.remainder;
        }
        return {
            data: decoded,
            remainder: input.subarray(totalLength),
        };
    }
}
const cachedHexes = Array.from({ length: 256 }, (_v, i) => i.toString(16).padStart(2, '0'));
function bytesToHex$2(uint8a) {
    // Pre-caching chars with `cachedHexes` speeds this up 6x
    let hex = '';
    for (let i = 0; i < uint8a.length; i++) {
        hex += cachedHexes[uint8a[i]];
    }
    return hex;
}
function parseHexByte(hexByte) {
    const byte = Number.parseInt(hexByte, 16);
    if (Number.isNaN(byte))
        throw new Error('Invalid byte sequence');
    return byte;
}
// Caching slows it down 2-3x
function hexToBytes$2(hex) {
    if (typeof hex !== 'string') {
        throw new TypeError('hexToBytes: expected string, got ' + typeof hex);
    }
    if (hex.length % 2)
        throw new Error('hexToBytes: received invalid unpadded hex');
    const array = new Uint8Array(hex.length / 2);
    for (let i = 0; i < array.length; i++) {
        const j = i * 2;
        array[i] = parseHexByte(hex.slice(j, j + 2));
    }
    return array;
}
/** Concatenates two Uint8Arrays into one. */
function concatBytes$3(...arrays) {
    if (arrays.length === 1)
        return arrays[0];
    const length = arrays.reduce((a, arr) => a + arr.length, 0);
    const result = new Uint8Array(length);
    for (let i = 0, pad = 0; i < arrays.length; i++) {
        const arr = arrays[i];
        result.set(arr, pad);
        pad += arr.length;
    }
    return result;
}
function utf8ToBytes$2(utf) {
    return new TextEncoder().encode(utf);
}
/** Transform an integer into its hexadecimal value */
function numberToHex(integer) {
    if (integer < 0) {
        throw new Error('Invalid integer as argument, must be unsigned!');
    }
    const hex = integer.toString(16);
    return hex.length % 2 ? `0${hex}` : hex;
}
/** Pad a string to be even */
function padToEven$1(a) {
    return a.length % 2 ? `0${a}` : a;
}
/** Check if a string is prefixed by 0x */
function isHexPrefixed$1(str) {
    return str.length >= 2 && str[0] === '0' && str[1] === 'x';
}
/** Removes 0x from a given String */
function stripHexPrefix$1(str) {
    if (typeof str !== 'string') {
        return str;
    }
    return isHexPrefixed$1(str) ? str.slice(2) : str;
}
/** Transform anything into a Uint8Array */
function toBytes$2(v) {
    if (v instanceof Uint8Array) {
        return v;
    }
    if (typeof v === 'string') {
        if (isHexPrefixed$1(v)) {
            return hexToBytes$2(padToEven$1(stripHexPrefix$1(v)));
        }
        return utf8ToBytes$2(v);
    }
    if (typeof v === 'number' || typeof v === 'bigint') {
        if (!v) {
            return Uint8Array.from([]);
        }
        return hexToBytes$2(numberToHex(v));
    }
    if (v === null || v === undefined) {
        return Uint8Array.from([]);
    }
    throw new Error('toBytes: received unsupported type ' + typeof v);
}
const RLP = { encode, decode };

function number(n) {
    if (!Number.isSafeInteger(n) || n < 0)
        throw new Error(`Wrong positive integer: ${n}`);
}
function bool(b) {
    if (typeof b !== 'boolean')
        throw new Error(`Expected boolean, not ${b}`);
}
// copied from utils
function isBytes$2(a) {
    return (a instanceof Uint8Array ||
        (a != null && typeof a === 'object' && a.constructor.name === 'Uint8Array'));
}
function bytes(b, ...lengths) {
    if (!isBytes$2(b))
        throw new Error('Expected Uint8Array');
    if (lengths.length > 0 && !lengths.includes(b.length))
        throw new Error(`Expected Uint8Array of length ${lengths}, not of length=${b.length}`);
}
function hash$1(hash) {
    if (typeof hash !== 'function' || typeof hash.create !== 'function')
        throw new Error('Hash should be wrapped by utils.wrapConstructor');
    number(hash.outputLen);
    number(hash.blockLen);
}
function exists(instance, checkFinished = true) {
    if (instance.destroyed)
        throw new Error('Hash instance has been destroyed');
    if (checkFinished && instance.finished)
        throw new Error('Hash#digest() has already been called');
}
function output(out, instance) {
    bytes(out);
    const min = instance.outputLen;
    if (out.length < min) {
        throw new Error(`digestInto() expects output buffer of length at least ${min}`);
    }
}
const assert = { number, bool, bytes, hash: hash$1, exists, output };

const crypto = typeof globalThis === 'object' && 'crypto' in globalThis ? globalThis.crypto : undefined;

/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// We use WebCrypto aka globalThis.crypto, which exists in browsers and node.js 16+.
// node.js versions earlier than v19 don't declare it in global scope.
// For node.js, package.json#exports field mapping rewrites import
// from `crypto` to `cryptoNode`, which imports native module.
// Makes the utils un-importable in browsers without a bundler.
// Once node.js 18 is deprecated (2025-04-30), we can just drop the import.
const u32 = (arr) => new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
function isBytes$1(a) {
    return (a instanceof Uint8Array ||
        (a != null && typeof a === 'object' && a.constructor.name === 'Uint8Array'));
}
// Cast array to view
const createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
// The rotate right (circular right shift) operation for uint32
const rotr = (word, shift) => (word << (32 - shift)) | (word >>> shift);
// big-endian hardware is rare. Just in case someone still decides to run hashes:
// early-throw an error because we don't support BE yet.
// Other libraries would silently corrupt the data instead of throwing an error,
// when they don't support it.
const isLE = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
if (!isLE)
    throw new Error('Non little-endian hardware is not supported');
/**
 * @example utf8ToBytes('abc') // new Uint8Array([97, 98, 99])
 */
function utf8ToBytes$1(str) {
    if (typeof str !== 'string')
        throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
    return new Uint8Array(new TextEncoder().encode(str)); // https://bugzil.la/1681809
}
/**
 * Normalizes (non-hex) string or Uint8Array to Uint8Array.
 * Warning: when Uint8Array is passed, it would NOT get copied.
 * Keep in mind for future mutable operations.
 */
function toBytes$1(data) {
    if (typeof data === 'string')
        data = utf8ToBytes$1(data);
    if (!isBytes$1(data))
        throw new Error(`expected Uint8Array, got ${typeof data}`);
    return data;
}
/**
 * Copies several Uint8Arrays into one.
 */
function concatBytes$2(...arrays) {
    let sum = 0;
    for (let i = 0; i < arrays.length; i++) {
        const a = arrays[i];
        if (!isBytes$1(a))
            throw new Error('Uint8Array expected');
        sum += a.length;
    }
    const res = new Uint8Array(sum);
    for (let i = 0, pad = 0; i < arrays.length; i++) {
        const a = arrays[i];
        res.set(a, pad);
        pad += a.length;
    }
    return res;
}
// For runtime check if class implements interface
class Hash {
    // Safe version that clones internal state
    clone() {
        return this._cloneInto();
    }
}
function wrapConstructor(hashCons) {
    const hashC = (msg) => hashCons().update(toBytes$1(msg)).digest();
    const tmp = hashCons();
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = () => hashCons();
    return hashC;
}
/**
 * Secure PRNG. Uses `crypto.getRandomValues`, which defers to OS.
 */
function randomBytes(bytesLength = 32) {
    if (crypto && typeof crypto.getRandomValues === 'function') {
        return crypto.getRandomValues(new Uint8Array(bytesLength));
    }
    throw new Error('crypto.getRandomValues must be defined');
}

// Polyfill for Safari 14
function setBigUint64(view, byteOffset, value, isLE) {
    if (typeof view.setBigUint64 === 'function')
        return view.setBigUint64(byteOffset, value, isLE);
    const _32n = BigInt(32);
    const _u32_max = BigInt(0xffffffff);
    const wh = Number((value >> _32n) & _u32_max);
    const wl = Number(value & _u32_max);
    const h = isLE ? 4 : 0;
    const l = isLE ? 0 : 4;
    view.setUint32(byteOffset + h, wh, isLE);
    view.setUint32(byteOffset + l, wl, isLE);
}
// Base SHA2 class (RFC 6234)
class SHA2 extends Hash {
    constructor(blockLen, outputLen, padOffset, isLE) {
        super();
        this.blockLen = blockLen;
        this.outputLen = outputLen;
        this.padOffset = padOffset;
        this.isLE = isLE;
        this.finished = false;
        this.length = 0;
        this.pos = 0;
        this.destroyed = false;
        this.buffer = new Uint8Array(blockLen);
        this.view = createView(this.buffer);
    }
    update(data) {
        exists(this);
        const { view, buffer, blockLen } = this;
        data = toBytes$1(data);
        const len = data.length;
        for (let pos = 0; pos < len;) {
            const take = Math.min(blockLen - this.pos, len - pos);
            // Fast path: we have at least one block in input, cast it to view and process
            if (take === blockLen) {
                const dataView = createView(data);
                for (; blockLen <= len - pos; pos += blockLen)
                    this.process(dataView, pos);
                continue;
            }
            buffer.set(data.subarray(pos, pos + take), this.pos);
            this.pos += take;
            pos += take;
            if (this.pos === blockLen) {
                this.process(view, 0);
                this.pos = 0;
            }
        }
        this.length += data.length;
        this.roundClean();
        return this;
    }
    digestInto(out) {
        exists(this);
        output(out, this);
        this.finished = true;
        // Padding
        // We can avoid allocation of buffer for padding completely if it
        // was previously not allocated here. But it won't change performance.
        const { buffer, view, blockLen, isLE } = this;
        let { pos } = this;
        // append the bit '1' to the message
        buffer[pos++] = 0b10000000;
        this.buffer.subarray(pos).fill(0);
        // we have less than padOffset left in buffer, so we cannot put length in current block, need process it and pad again
        if (this.padOffset > blockLen - pos) {
            this.process(view, 0);
            pos = 0;
        }
        // Pad until full block byte with zeros
        for (let i = pos; i < blockLen; i++)
            buffer[i] = 0;
        // Note: sha512 requires length to be 128bit integer, but length in JS will overflow before that
        // You need to write around 2 exabytes (u64_max / 8 / (1024**6)) for this to happen.
        // So we just write lowest 64 bits of that value.
        setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
        this.process(view, 0);
        const oview = createView(out);
        const len = this.outputLen;
        // NOTE: we do division by 4 later, which should be fused in single op with modulo by JIT
        if (len % 4)
            throw new Error('_sha2: outputLen should be aligned to 32bit');
        const outLen = len / 4;
        const state = this.get();
        if (outLen > state.length)
            throw new Error('_sha2: outputLen bigger than state');
        for (let i = 0; i < outLen; i++)
            oview.setUint32(4 * i, state[i], isLE);
    }
    digest() {
        const { buffer, outputLen } = this;
        this.digestInto(buffer);
        const res = buffer.slice(0, outputLen);
        this.destroy();
        return res;
    }
    _cloneInto(to) {
        to || (to = new this.constructor());
        to.set(...this.get());
        const { blockLen, buffer, length, finished, destroyed, pos } = this;
        to.length = length;
        to.pos = pos;
        to.finished = finished;
        to.destroyed = destroyed;
        if (length % blockLen)
            to.buffer.set(buffer);
        return to;
    }
}

// SHA2-256 need to try 2^128 hashes to execute birthday attack.
// BTC network is doing 2^67 hashes/sec as per early 2023.
// Choice: a ? b : c
const Chi = (a, b, c) => (a & b) ^ (~a & c);
// Majority function, true if any two inpust is true
const Maj = (a, b, c) => (a & b) ^ (a & c) ^ (b & c);
// Round constants:
// first 32 bits of the fractional parts of the cube roots of the first 64 primes 2..311)
// prettier-ignore
const SHA256_K = /* @__PURE__ */ new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
// Initial state (first 32 bits of the fractional parts of the square roots of the first 8 primes 2..19):
// prettier-ignore
const IV = /* @__PURE__ */ new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);
// Temporary buffer, not used to store anything between runs
// Named this way because it matches specification.
const SHA256_W = /* @__PURE__ */ new Uint32Array(64);
class SHA256 extends SHA2 {
    constructor() {
        super(64, 32, 8, false);
        // We cannot use array here since array allows indexing by variable
        // which means optimizer/compiler cannot use registers.
        this.A = IV[0] | 0;
        this.B = IV[1] | 0;
        this.C = IV[2] | 0;
        this.D = IV[3] | 0;
        this.E = IV[4] | 0;
        this.F = IV[5] | 0;
        this.G = IV[6] | 0;
        this.H = IV[7] | 0;
    }
    get() {
        const { A, B, C, D, E, F, G, H } = this;
        return [A, B, C, D, E, F, G, H];
    }
    // prettier-ignore
    set(A, B, C, D, E, F, G, H) {
        this.A = A | 0;
        this.B = B | 0;
        this.C = C | 0;
        this.D = D | 0;
        this.E = E | 0;
        this.F = F | 0;
        this.G = G | 0;
        this.H = H | 0;
    }
    process(view, offset) {
        // Extend the first 16 words into the remaining 48 words w[16..63] of the message schedule array
        for (let i = 0; i < 16; i++, offset += 4)
            SHA256_W[i] = view.getUint32(offset, false);
        for (let i = 16; i < 64; i++) {
            const W15 = SHA256_W[i - 15];
            const W2 = SHA256_W[i - 2];
            const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ (W15 >>> 3);
            const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ (W2 >>> 10);
            SHA256_W[i] = (s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16]) | 0;
        }
        // Compression function main loop, 64 rounds
        let { A, B, C, D, E, F, G, H } = this;
        for (let i = 0; i < 64; i++) {
            const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
            const T1 = (H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i]) | 0;
            const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
            const T2 = (sigma0 + Maj(A, B, C)) | 0;
            H = G;
            G = F;
            F = E;
            E = (D + T1) | 0;
            D = C;
            C = B;
            B = A;
            A = (T1 + T2) | 0;
        }
        // Add the compressed chunk to the current hash value
        A = (A + this.A) | 0;
        B = (B + this.B) | 0;
        C = (C + this.C) | 0;
        D = (D + this.D) | 0;
        E = (E + this.E) | 0;
        F = (F + this.F) | 0;
        G = (G + this.G) | 0;
        H = (H + this.H) | 0;
        this.set(A, B, C, D, E, F, G, H);
    }
    roundClean() {
        SHA256_W.fill(0);
    }
    destroy() {
        this.set(0, 0, 0, 0, 0, 0, 0, 0);
        this.buffer.fill(0);
    }
}
/**
 * SHA2-256 hash function
 * @param message - data that would be hashed
 */
const sha256$1 = /* @__PURE__ */ wrapConstructor(() => new SHA256());

/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// 100 lines of code in the file are duplicated from noble-hashes (utils).
// This is OK: `abstract` directory does not use noble-hashes.
// User may opt-in into using different hashing library. This way, noble-hashes
// won't be included into their bundle.
const _0n$4 = BigInt(0);
const _1n$5 = BigInt(1);
const _2n$3 = BigInt(2);
function isBytes(a) {
    return (a instanceof Uint8Array ||
        (a != null && typeof a === 'object' && a.constructor.name === 'Uint8Array'));
}
// Array where index 0xf0 (240) is mapped to string 'f0'
const hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
/**
 * @example bytesToHex(Uint8Array.from([0xca, 0xfe, 0x01, 0x23])) // 'cafe0123'
 */
function bytesToHex$1(bytes) {
    if (!isBytes(bytes))
        throw new Error('Uint8Array expected');
    // pre-caching improves the speed 6x
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += hexes[bytes[i]];
    }
    return hex;
}
function numberToHexUnpadded(num) {
    const hex = num.toString(16);
    return hex.length & 1 ? `0${hex}` : hex;
}
function hexToNumber(hex) {
    if (typeof hex !== 'string')
        throw new Error('hex string expected, got ' + typeof hex);
    // Big Endian
    return BigInt(hex === '' ? '0' : `0x${hex}`);
}
// We use optimized technique to convert hex string to byte array
const asciis = { _0: 48, _9: 57, _A: 65, _F: 70, _a: 97, _f: 102 };
function asciiToBase16(char) {
    if (char >= asciis._0 && char <= asciis._9)
        return char - asciis._0;
    if (char >= asciis._A && char <= asciis._F)
        return char - (asciis._A - 10);
    if (char >= asciis._a && char <= asciis._f)
        return char - (asciis._a - 10);
    return;
}
/**
 * @example hexToBytes('cafe0123') // Uint8Array.from([0xca, 0xfe, 0x01, 0x23])
 */
function hexToBytes$1(hex) {
    if (typeof hex !== 'string')
        throw new Error('hex string expected, got ' + typeof hex);
    const hl = hex.length;
    const al = hl / 2;
    if (hl % 2)
        throw new Error('padded hex string expected, got unpadded hex of length ' + hl);
    const array = new Uint8Array(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
        const n1 = asciiToBase16(hex.charCodeAt(hi));
        const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
        if (n1 === undefined || n2 === undefined) {
            const char = hex[hi] + hex[hi + 1];
            throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
        }
        array[ai] = n1 * 16 + n2;
    }
    return array;
}
// BE: Big Endian, LE: Little Endian
function bytesToNumberBE(bytes) {
    return hexToNumber(bytesToHex$1(bytes));
}
function bytesToNumberLE(bytes) {
    if (!isBytes(bytes))
        throw new Error('Uint8Array expected');
    return hexToNumber(bytesToHex$1(Uint8Array.from(bytes).reverse()));
}
function numberToBytesBE(n, len) {
    return hexToBytes$1(n.toString(16).padStart(len * 2, '0'));
}
function numberToBytesLE(n, len) {
    return numberToBytesBE(n, len).reverse();
}
// Unpadded, rarely used
function numberToVarBytesBE(n) {
    return hexToBytes$1(numberToHexUnpadded(n));
}
/**
 * Takes hex string or Uint8Array, converts to Uint8Array.
 * Validates output length.
 * Will throw error for other types.
 * @param title descriptive title for an error e.g. 'private key'
 * @param hex hex string or Uint8Array
 * @param expectedLength optional, will compare to result array's length
 * @returns
 */
function ensureBytes(title, hex, expectedLength) {
    let res;
    if (typeof hex === 'string') {
        try {
            res = hexToBytes$1(hex);
        }
        catch (e) {
            throw new Error(`${title} must be valid hex string, got "${hex}". Cause: ${e}`);
        }
    }
    else if (isBytes(hex)) {
        // Uint8Array.from() instead of hash.slice() because node.js Buffer
        // is instance of Uint8Array, and its slice() creates **mutable** copy
        res = Uint8Array.from(hex);
    }
    else {
        throw new Error(`${title} must be hex string or Uint8Array`);
    }
    const len = res.length;
    if (typeof expectedLength === 'number' && len !== expectedLength)
        throw new Error(`${title} expected ${expectedLength} bytes, got ${len}`);
    return res;
}
/**
 * Copies several Uint8Arrays into one.
 */
function concatBytes$1(...arrays) {
    let sum = 0;
    for (let i = 0; i < arrays.length; i++) {
        const a = arrays[i];
        if (!isBytes(a))
            throw new Error('Uint8Array expected');
        sum += a.length;
    }
    let res = new Uint8Array(sum);
    let pad = 0;
    for (let i = 0; i < arrays.length; i++) {
        const a = arrays[i];
        res.set(a, pad);
        pad += a.length;
    }
    return res;
}
// Compares 2 u8a-s in kinda constant time
function equalBytes(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0;
}
/**
 * @example utf8ToBytes('abc') // new Uint8Array([97, 98, 99])
 */
function utf8ToBytes(str) {
    if (typeof str !== 'string')
        throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
    return new Uint8Array(new TextEncoder().encode(str)); // https://bugzil.la/1681809
}
// Bit operations
/**
 * Calculates amount of bits in a bigint.
 * Same as `n.toString(2).length`
 */
function bitLen(n) {
    let len;
    for (len = 0; n > _0n$4; n >>= _1n$5, len += 1)
        ;
    return len;
}
/**
 * Gets single bit at position.
 * NOTE: first bit position is 0 (same as arrays)
 * Same as `!!+Array.from(n.toString(2)).reverse()[pos]`
 */
function bitGet(n, pos) {
    return (n >> BigInt(pos)) & _1n$5;
}
/**
 * Sets single bit at position.
 */
const bitSet = (n, pos, value) => {
    return n | ((value ? _1n$5 : _0n$4) << BigInt(pos));
};
/**
 * Calculate mask for N bits. Not using ** operator with bigints because of old engines.
 * Same as BigInt(`0b${Array(i).fill('1').join('')}`)
 */
const bitMask = (n) => (_2n$3 << BigInt(n - 1)) - _1n$5;
// DRBG
const u8n = (data) => new Uint8Array(data); // creates Uint8Array
const u8fr = (arr) => Uint8Array.from(arr); // another shortcut
/**
 * Minimal HMAC-DRBG from NIST 800-90 for RFC6979 sigs.
 * @returns function that will call DRBG until 2nd arg returns something meaningful
 * @example
 *   const drbg = createHmacDRBG<Key>(32, 32, hmac);
 *   drbg(seed, bytesToKey); // bytesToKey must return Key or undefined
 */
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
    if (typeof hashLen !== 'number' || hashLen < 2)
        throw new Error('hashLen must be a number');
    if (typeof qByteLen !== 'number' || qByteLen < 2)
        throw new Error('qByteLen must be a number');
    if (typeof hmacFn !== 'function')
        throw new Error('hmacFn must be a function');
    // Step B, Step C: set hashLen to 8*ceil(hlen/8)
    let v = u8n(hashLen); // Minimal non-full-spec HMAC-DRBG from NIST 800-90 for RFC6979 sigs.
    let k = u8n(hashLen); // Steps B and C of RFC6979 3.2: set hashLen, in our case always same
    let i = 0; // Iterations counter, will throw when over 1000
    const reset = () => {
        v.fill(1);
        k.fill(0);
        i = 0;
    };
    const h = (...b) => hmacFn(k, v, ...b); // hmac(k)(v, ...values)
    const reseed = (seed = u8n()) => {
        // HMAC-DRBG reseed() function. Steps D-G
        k = h(u8fr([0x00]), seed); // k = hmac(k || v || 0x00 || seed)
        v = h(); // v = hmac(k || v)
        if (seed.length === 0)
            return;
        k = h(u8fr([0x01]), seed); // k = hmac(k || v || 0x01 || seed)
        v = h(); // v = hmac(k || v)
    };
    const gen = () => {
        // HMAC-DRBG generate() function
        if (i++ >= 1000)
            throw new Error('drbg: tried 1000 values');
        let len = 0;
        const out = [];
        while (len < qByteLen) {
            v = h();
            const sl = v.slice();
            out.push(sl);
            len += v.length;
        }
        return concatBytes$1(...out);
    };
    const genUntil = (seed, pred) => {
        reset();
        reseed(seed); // Steps D-G
        let res = undefined; // Step H: grind until k is in [1..n-1]
        while (!(res = pred(gen())))
            reseed();
        reset();
        return res;
    };
    return genUntil;
}
// Validating curves and fields
const validatorFns = {
    bigint: (val) => typeof val === 'bigint',
    function: (val) => typeof val === 'function',
    boolean: (val) => typeof val === 'boolean',
    string: (val) => typeof val === 'string',
    stringOrUint8Array: (val) => typeof val === 'string' || isBytes(val),
    isSafeInteger: (val) => Number.isSafeInteger(val),
    array: (val) => Array.isArray(val),
    field: (val, object) => object.Fp.isValid(val),
    hash: (val) => typeof val === 'function' && Number.isSafeInteger(val.outputLen),
};
// type Record<K extends string | number | symbol, T> = { [P in K]: T; }
function validateObject(object, validators, optValidators = {}) {
    const checkField = (fieldName, type, isOptional) => {
        const checkVal = validatorFns[type];
        if (typeof checkVal !== 'function')
            throw new Error(`Invalid validator "${type}", expected function`);
        const val = object[fieldName];
        if (isOptional && val === undefined)
            return;
        if (!checkVal(val, object)) {
            throw new Error(`Invalid param ${String(fieldName)}=${val} (${typeof val}), expected ${type}`);
        }
    };
    for (const [fieldName, type] of Object.entries(validators))
        checkField(fieldName, type, false);
    for (const [fieldName, type] of Object.entries(optValidators))
        checkField(fieldName, type, true);
    return object;
}
// validate type tests
// const o: { a: number; b: number; c: number } = { a: 1, b: 5, c: 6 };
// const z0 = validateObject(o, { a: 'isSafeInteger' }, { c: 'bigint' }); // Ok!
// // Should fail type-check
// const z1 = validateObject(o, { a: 'tmp' }, { c: 'zz' });
// const z2 = validateObject(o, { a: 'isSafeInteger' }, { c: 'zz' });
// const z3 = validateObject(o, { test: 'boolean', z: 'bug' });
// const z4 = validateObject(o, { a: 'boolean', z: 'bug' });

var ut = /*#__PURE__*/Object.freeze({
    __proto__: null,
    bitGet: bitGet,
    bitLen: bitLen,
    bitMask: bitMask,
    bitSet: bitSet,
    bytesToHex: bytesToHex$1,
    bytesToNumberBE: bytesToNumberBE,
    bytesToNumberLE: bytesToNumberLE,
    concatBytes: concatBytes$1,
    createHmacDrbg: createHmacDrbg,
    ensureBytes: ensureBytes,
    equalBytes: equalBytes,
    hexToBytes: hexToBytes$1,
    hexToNumber: hexToNumber,
    isBytes: isBytes,
    numberToBytesBE: numberToBytesBE,
    numberToBytesLE: numberToBytesLE,
    numberToHexUnpadded: numberToHexUnpadded,
    numberToVarBytesBE: numberToVarBytesBE,
    utf8ToBytes: utf8ToBytes,
    validateObject: validateObject
});

/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// Utilities for modular arithmetics and finite fields
// prettier-ignore
const _0n$3 = BigInt(0), _1n$4 = BigInt(1), _2n$2 = BigInt(2), _3n$1 = BigInt(3);
// prettier-ignore
const _4n = BigInt(4), _5n = BigInt(5), _8n = BigInt(8);
// prettier-ignore
BigInt(9); BigInt(16);
// Calculates a modulo b
function mod(a, b) {
    const result = a % b;
    return result >= _0n$3 ? result : b + result;
}
/**
 * Efficiently raise num to power and do modular division.
 * Unsafe in some contexts: uses ladder, so can expose bigint bits.
 * @example
 * pow(2n, 6n, 11n) // 64n % 11n == 9n
 */
// TODO: use field version && remove
function pow(num, power, modulo) {
    if (modulo <= _0n$3 || power < _0n$3)
        throw new Error('Expected power/modulo > 0');
    if (modulo === _1n$4)
        return _0n$3;
    let res = _1n$4;
    while (power > _0n$3) {
        if (power & _1n$4)
            res = (res * num) % modulo;
        num = (num * num) % modulo;
        power >>= _1n$4;
    }
    return res;
}
// Does x ^ (2 ^ power) mod p. pow2(30, 4) == 30 ^ (2 ^ 4)
function pow2(x, power, modulo) {
    let res = x;
    while (power-- > _0n$3) {
        res *= res;
        res %= modulo;
    }
    return res;
}
// Inverses number over modulo
function invert(number, modulo) {
    if (number === _0n$3 || modulo <= _0n$3) {
        throw new Error(`invert: expected positive integers, got n=${number} mod=${modulo}`);
    }
    // Euclidean GCD https://brilliant.org/wiki/extended-euclidean-algorithm/
    // Fermat's little theorem "CT-like" version inv(n) = n^(m-2) mod m is 30x slower.
    let a = mod(number, modulo);
    let b = modulo;
    // prettier-ignore
    let x = _0n$3, u = _1n$4;
    while (a !== _0n$3) {
        // JIT applies optimization if those two lines follow each other
        const q = b / a;
        const r = b % a;
        const m = x - u * q;
        // prettier-ignore
        b = a, a = r, x = u, u = m;
    }
    const gcd = b;
    if (gcd !== _1n$4)
        throw new Error('invert: does not exist');
    return mod(x, modulo);
}
/**
 * Tonelli-Shanks square root search algorithm.
 * 1. https://eprint.iacr.org/2012/685.pdf (page 12)
 * 2. Square Roots from 1; 24, 51, 10 to Dan Shanks
 * Will start an infinite loop if field order P is not prime.
 * @param P field order
 * @returns function that takes field Fp (created from P) and number n
 */
function tonelliShanks(P) {
    // Legendre constant: used to calculate Legendre symbol (a | p),
    // which denotes the value of a^((p-1)/2) (mod p).
    // (a | p) ≡ 1    if a is a square (mod p)
    // (a | p) ≡ -1   if a is not a square (mod p)
    // (a | p) ≡ 0    if a ≡ 0 (mod p)
    const legendreC = (P - _1n$4) / _2n$2;
    let Q, S, Z;
    // Step 1: By factoring out powers of 2 from p - 1,
    // find q and s such that p - 1 = q*(2^s) with q odd
    for (Q = P - _1n$4, S = 0; Q % _2n$2 === _0n$3; Q /= _2n$2, S++)
        ;
    // Step 2: Select a non-square z such that (z | p) ≡ -1 and set c ≡ zq
    for (Z = _2n$2; Z < P && pow(Z, legendreC, P) !== P - _1n$4; Z++)
        ;
    // Fast-path
    if (S === 1) {
        const p1div4 = (P + _1n$4) / _4n;
        return function tonelliFast(Fp, n) {
            const root = Fp.pow(n, p1div4);
            if (!Fp.eql(Fp.sqr(root), n))
                throw new Error('Cannot find square root');
            return root;
        };
    }
    // Slow-path
    const Q1div2 = (Q + _1n$4) / _2n$2;
    return function tonelliSlow(Fp, n) {
        // Step 0: Check that n is indeed a square: (n | p) should not be ≡ -1
        if (Fp.pow(n, legendreC) === Fp.neg(Fp.ONE))
            throw new Error('Cannot find square root');
        let r = S;
        // TODO: will fail at Fp2/etc
        let g = Fp.pow(Fp.mul(Fp.ONE, Z), Q); // will update both x and b
        let x = Fp.pow(n, Q1div2); // first guess at the square root
        let b = Fp.pow(n, Q); // first guess at the fudge factor
        while (!Fp.eql(b, Fp.ONE)) {
            if (Fp.eql(b, Fp.ZERO))
                return Fp.ZERO; // https://en.wikipedia.org/wiki/Tonelli%E2%80%93Shanks_algorithm (4. If t = 0, return r = 0)
            // Find m such b^(2^m)==1
            let m = 1;
            for (let t2 = Fp.sqr(b); m < r; m++) {
                if (Fp.eql(t2, Fp.ONE))
                    break;
                t2 = Fp.sqr(t2); // t2 *= t2
            }
            // NOTE: r-m-1 can be bigger than 32, need to convert to bigint before shift, otherwise there will be overflow
            const ge = Fp.pow(g, _1n$4 << BigInt(r - m - 1)); // ge = 2^(r-m-1)
            g = Fp.sqr(ge); // g = ge * ge
            x = Fp.mul(x, ge); // x *= ge
            b = Fp.mul(b, g); // b *= g
            r = m;
        }
        return x;
    };
}
function FpSqrt(P) {
    // NOTE: different algorithms can give different roots, it is up to user to decide which one they want.
    // For example there is FpSqrtOdd/FpSqrtEven to choice root based on oddness (used for hash-to-curve).
    // P ≡ 3 (mod 4)
    // √n = n^((P+1)/4)
    if (P % _4n === _3n$1) {
        // Not all roots possible!
        // const ORDER =
        //   0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;
        // const NUM = 72057594037927816n;
        const p1div4 = (P + _1n$4) / _4n;
        return function sqrt3mod4(Fp, n) {
            const root = Fp.pow(n, p1div4);
            // Throw if root**2 != n
            if (!Fp.eql(Fp.sqr(root), n))
                throw new Error('Cannot find square root');
            return root;
        };
    }
    // Atkin algorithm for q ≡ 5 (mod 8), https://eprint.iacr.org/2012/685.pdf (page 10)
    if (P % _8n === _5n) {
        const c1 = (P - _5n) / _8n;
        return function sqrt5mod8(Fp, n) {
            const n2 = Fp.mul(n, _2n$2);
            const v = Fp.pow(n2, c1);
            const nv = Fp.mul(n, v);
            const i = Fp.mul(Fp.mul(nv, _2n$2), v);
            const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
            if (!Fp.eql(Fp.sqr(root), n))
                throw new Error('Cannot find square root');
            return root;
        };
    }
    // Other cases: Tonelli-Shanks algorithm
    return tonelliShanks(P);
}
// prettier-ignore
const FIELD_FIELDS = [
    'create', 'isValid', 'is0', 'neg', 'inv', 'sqrt', 'sqr',
    'eql', 'add', 'sub', 'mul', 'pow', 'div',
    'addN', 'subN', 'mulN', 'sqrN'
];
function validateField(field) {
    const initial = {
        ORDER: 'bigint',
        MASK: 'bigint',
        BYTES: 'isSafeInteger',
        BITS: 'isSafeInteger',
    };
    const opts = FIELD_FIELDS.reduce((map, val) => {
        map[val] = 'function';
        return map;
    }, initial);
    return validateObject(field, opts);
}
// Generic field functions
/**
 * Same as `pow` but for Fp: non-constant-time.
 * Unsafe in some contexts: uses ladder, so can expose bigint bits.
 */
function FpPow(f, num, power) {
    // Should have same speed as pow for bigints
    // TODO: benchmark!
    if (power < _0n$3)
        throw new Error('Expected power > 0');
    if (power === _0n$3)
        return f.ONE;
    if (power === _1n$4)
        return num;
    let p = f.ONE;
    let d = num;
    while (power > _0n$3) {
        if (power & _1n$4)
            p = f.mul(p, d);
        d = f.sqr(d);
        power >>= _1n$4;
    }
    return p;
}
/**
 * Efficiently invert an array of Field elements.
 * `inv(0)` will return `undefined` here: make sure to throw an error.
 */
function FpInvertBatch(f, nums) {
    const tmp = new Array(nums.length);
    // Walk from first to last, multiply them by each other MOD p
    const lastMultiplied = nums.reduce((acc, num, i) => {
        if (f.is0(num))
            return acc;
        tmp[i] = acc;
        return f.mul(acc, num);
    }, f.ONE);
    // Invert last element
    const inverted = f.inv(lastMultiplied);
    // Walk from last to first, multiply them by inverted each other MOD p
    nums.reduceRight((acc, num, i) => {
        if (f.is0(num))
            return acc;
        tmp[i] = f.mul(acc, tmp[i]);
        return f.mul(acc, num);
    }, inverted);
    return tmp;
}
// CURVE.n lengths
function nLength(n, nBitLength) {
    // Bit size, byte size of CURVE.n
    const _nBitLength = nBitLength !== undefined ? nBitLength : n.toString(2).length;
    const nByteLength = Math.ceil(_nBitLength / 8);
    return { nBitLength: _nBitLength, nByteLength };
}
/**
 * Initializes a finite field over prime. **Non-primes are not supported.**
 * Do not init in loop: slow. Very fragile: always run a benchmark on a change.
 * Major performance optimizations:
 * * a) denormalized operations like mulN instead of mul
 * * b) same object shape: never add or remove keys
 * * c) Object.freeze
 * @param ORDER prime positive bigint
 * @param bitLen how many bits the field consumes
 * @param isLE (def: false) if encoding / decoding should be in little-endian
 * @param redef optional faster redefinitions of sqrt and other methods
 */
function Field(ORDER, bitLen, isLE = false, redef = {}) {
    if (ORDER <= _0n$3)
        throw new Error(`Expected Field ORDER > 0, got ${ORDER}`);
    const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, bitLen);
    if (BYTES > 2048)
        throw new Error('Field lengths over 2048 bytes are not supported');
    const sqrtP = FpSqrt(ORDER);
    const f = Object.freeze({
        ORDER,
        BITS,
        BYTES,
        MASK: bitMask(BITS),
        ZERO: _0n$3,
        ONE: _1n$4,
        create: (num) => mod(num, ORDER),
        isValid: (num) => {
            if (typeof num !== 'bigint')
                throw new Error(`Invalid field element: expected bigint, got ${typeof num}`);
            return _0n$3 <= num && num < ORDER; // 0 is valid element, but it's not invertible
        },
        is0: (num) => num === _0n$3,
        isOdd: (num) => (num & _1n$4) === _1n$4,
        neg: (num) => mod(-num, ORDER),
        eql: (lhs, rhs) => lhs === rhs,
        sqr: (num) => mod(num * num, ORDER),
        add: (lhs, rhs) => mod(lhs + rhs, ORDER),
        sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
        mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
        pow: (num, power) => FpPow(f, num, power),
        div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
        // Same as above, but doesn't normalize
        sqrN: (num) => num * num,
        addN: (lhs, rhs) => lhs + rhs,
        subN: (lhs, rhs) => lhs - rhs,
        mulN: (lhs, rhs) => lhs * rhs,
        inv: (num) => invert(num, ORDER),
        sqrt: redef.sqrt || ((n) => sqrtP(f, n)),
        invertBatch: (lst) => FpInvertBatch(f, lst),
        // TODO: do we really need constant cmov?
        // We don't have const-time bigints anyway, so probably will be not very useful
        cmov: (a, b, c) => (c ? b : a),
        toBytes: (num) => (isLE ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES)),
        fromBytes: (bytes) => {
            if (bytes.length !== BYTES)
                throw new Error(`Fp.fromBytes: expected ${BYTES}, got ${bytes.length}`);
            return isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
        },
    });
    return Object.freeze(f);
}
/**
 * Returns total number of bytes consumed by the field element.
 * For example, 32 bytes for usual 256-bit weierstrass curve.
 * @param fieldOrder number of field elements, usually CURVE.n
 * @returns byte length of field
 */
function getFieldBytesLength(fieldOrder) {
    if (typeof fieldOrder !== 'bigint')
        throw new Error('field order must be bigint');
    const bitLength = fieldOrder.toString(2).length;
    return Math.ceil(bitLength / 8);
}
/**
 * Returns minimal amount of bytes that can be safely reduced
 * by field order.
 * Should be 2^-128 for 128-bit curve such as P256.
 * @param fieldOrder number of field elements, usually CURVE.n
 * @returns byte length of target hash
 */
function getMinHashLength(fieldOrder) {
    const length = getFieldBytesLength(fieldOrder);
    return length + Math.ceil(length / 2);
}
/**
 * "Constant-time" private key generation utility.
 * Can take (n + n/2) or more bytes of uniform input e.g. from CSPRNG or KDF
 * and convert them into private scalar, with the modulo bias being negligible.
 * Needs at least 48 bytes of input for 32-byte private key.
 * https://research.kudelskisecurity.com/2020/07/28/the-definitive-guide-to-modulo-bias-and-how-to-avoid-it/
 * FIPS 186-5, A.2 https://csrc.nist.gov/publications/detail/fips/186/5/final
 * RFC 9380, https://www.rfc-editor.org/rfc/rfc9380#section-5
 * @param hash hash output from SHA3 or a similar function
 * @param groupOrder size of subgroup - (e.g. secp256k1.CURVE.n)
 * @param isLE interpret hash bytes as LE num
 * @returns valid private scalar
 */
function mapHashToField(key, fieldOrder, isLE = false) {
    const len = key.length;
    const fieldLen = getFieldBytesLength(fieldOrder);
    const minLen = getMinHashLength(fieldOrder);
    // No small numbers: need to understand bias story. No huge numbers: easier to detect JS timings.
    if (len < 16 || len < minLen || len > 1024)
        throw new Error(`expected ${minLen}-1024 bytes of input, got ${len}`);
    const num = isLE ? bytesToNumberBE(key) : bytesToNumberLE(key);
    // `mod(x, 11)` can sometimes produce 0. `mod(x, 10) + 1` is the same, but no 0
    const reduced = mod(num, fieldOrder - _1n$4) + _1n$4;
    return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}

/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// Abelian group utilities
const _0n$2 = BigInt(0);
const _1n$3 = BigInt(1);
// Elliptic curve multiplication of Point by scalar. Fragile.
// Scalars should always be less than curve order: this should be checked inside of a curve itself.
// Creates precomputation tables for fast multiplication:
// - private scalar is split by fixed size windows of W bits
// - every window point is collected from window's table & added to accumulator
// - since windows are different, same point inside tables won't be accessed more than once per calc
// - each multiplication is 'Math.ceil(CURVE_ORDER / 𝑊) + 1' point additions (fixed for any scalar)
// - +1 window is neccessary for wNAF
// - wNAF reduces table size: 2x less memory + 2x faster generation, but 10% slower multiplication
// TODO: Research returning 2d JS array of windows, instead of a single window. This would allow
// windows to be in different memory locations
function wNAF(c, bits) {
    const constTimeNegate = (condition, item) => {
        const neg = item.negate();
        return condition ? neg : item;
    };
    const opts = (W) => {
        const windows = Math.ceil(bits / W) + 1; // +1, because
        const windowSize = 2 ** (W - 1); // -1 because we skip zero
        return { windows, windowSize };
    };
    return {
        constTimeNegate,
        // non-const time multiplication ladder
        unsafeLadder(elm, n) {
            let p = c.ZERO;
            let d = elm;
            while (n > _0n$2) {
                if (n & _1n$3)
                    p = p.add(d);
                d = d.double();
                n >>= _1n$3;
            }
            return p;
        },
        /**
         * Creates a wNAF precomputation window. Used for caching.
         * Default window size is set by `utils.precompute()` and is equal to 8.
         * Number of precomputed points depends on the curve size:
         * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
         * - 𝑊 is the window size
         * - 𝑛 is the bitlength of the curve order.
         * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
         * @returns precomputed point tables flattened to a single array
         */
        precomputeWindow(elm, W) {
            const { windows, windowSize } = opts(W);
            const points = [];
            let p = elm;
            let base = p;
            for (let window = 0; window < windows; window++) {
                base = p;
                points.push(base);
                // =1, because we skip zero
                for (let i = 1; i < windowSize; i++) {
                    base = base.add(p);
                    points.push(base);
                }
                p = base.double();
            }
            return points;
        },
        /**
         * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
         * @param W window size
         * @param precomputes precomputed tables
         * @param n scalar (we don't check here, but should be less than curve order)
         * @returns real and fake (for const-time) points
         */
        wNAF(W, precomputes, n) {
            // TODO: maybe check that scalar is less than group order? wNAF behavious is undefined otherwise
            // But need to carefully remove other checks before wNAF. ORDER == bits here
            const { windows, windowSize } = opts(W);
            let p = c.ZERO;
            let f = c.BASE;
            const mask = BigInt(2 ** W - 1); // Create mask with W ones: 0b1111 for W=4 etc.
            const maxNumber = 2 ** W;
            const shiftBy = BigInt(W);
            for (let window = 0; window < windows; window++) {
                const offset = window * windowSize;
                // Extract W bits.
                let wbits = Number(n & mask);
                // Shift number by W bits.
                n >>= shiftBy;
                // If the bits are bigger than max size, we'll split those.
                // +224 => 256 - 32
                if (wbits > windowSize) {
                    wbits -= maxNumber;
                    n += _1n$3;
                }
                // This code was first written with assumption that 'f' and 'p' will never be infinity point:
                // since each addition is multiplied by 2 ** W, it cannot cancel each other. However,
                // there is negate now: it is possible that negated element from low value
                // would be the same as high element, which will create carry into next window.
                // It's not obvious how this can fail, but still worth investigating later.
                // Check if we're onto Zero point.
                // Add random point inside current window to f.
                const offset1 = offset;
                const offset2 = offset + Math.abs(wbits) - 1; // -1 because we skip zero
                const cond1 = window % 2 !== 0;
                const cond2 = wbits < 0;
                if (wbits === 0) {
                    // The most important part for const-time getPublicKey
                    f = f.add(constTimeNegate(cond1, precomputes[offset1]));
                }
                else {
                    p = p.add(constTimeNegate(cond2, precomputes[offset2]));
                }
            }
            // JIT-compiler should not eliminate f here, since it will later be used in normalizeZ()
            // Even if the variable is still unused, there are some checks which will
            // throw an exception, so compiler needs to prove they won't happen, which is hard.
            // At this point there is a way to F be infinity-point even if p is not,
            // which makes it less const-time: around 1 bigint multiply.
            return { p, f };
        },
        wNAFCached(P, precomputesMap, n, transform) {
            // @ts-ignore
            const W = P._WINDOW_SIZE || 1;
            // Calculate precomputes on a first run, reuse them after
            let comp = precomputesMap.get(P);
            if (!comp) {
                comp = this.precomputeWindow(P, W);
                if (W !== 1) {
                    precomputesMap.set(P, transform(comp));
                }
            }
            return this.wNAF(W, comp, n);
        },
    };
}
function validateBasic(curve) {
    validateField(curve.Fp);
    validateObject(curve, {
        n: 'bigint',
        h: 'bigint',
        Gx: 'field',
        Gy: 'field',
    }, {
        nBitLength: 'isSafeInteger',
        nByteLength: 'isSafeInteger',
    });
    // Set defaults
    return Object.freeze({
        ...nLength(curve.n, curve.nBitLength),
        ...curve,
        ...{ p: curve.Fp.ORDER },
    });
}

/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// Short Weierstrass curve. The formula is: y² = x³ + ax + b
function validatePointOpts(curve) {
    const opts = validateBasic(curve);
    validateObject(opts, {
        a: 'field',
        b: 'field',
    }, {
        allowedPrivateKeyLengths: 'array',
        wrapPrivateKey: 'boolean',
        isTorsionFree: 'function',
        clearCofactor: 'function',
        allowInfinityPoint: 'boolean',
        fromBytes: 'function',
        toBytes: 'function',
    });
    const { endo, Fp, a } = opts;
    if (endo) {
        if (!Fp.eql(a, Fp.ZERO)) {
            throw new Error('Endomorphism can only be defined for Koblitz curves that have a=0');
        }
        if (typeof endo !== 'object' ||
            typeof endo.beta !== 'bigint' ||
            typeof endo.splitScalar !== 'function') {
            throw new Error('Expected endomorphism with beta: bigint and splitScalar: function');
        }
    }
    return Object.freeze({ ...opts });
}
// ASN.1 DER encoding utilities
const { bytesToNumberBE: b2n, hexToBytes: h2b } = ut;
const DER = {
    // asn.1 DER encoding utils
    Err: class DERErr extends Error {
        constructor(m = '') {
            super(m);
        }
    },
    _parseInt(data) {
        const { Err: E } = DER;
        if (data.length < 2 || data[0] !== 0x02)
            throw new E('Invalid signature integer tag');
        const len = data[1];
        const res = data.subarray(2, len + 2);
        if (!len || res.length !== len)
            throw new E('Invalid signature integer: wrong length');
        // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
        // since we always use positive integers here. It must always be empty:
        // - add zero byte if exists
        // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
        if (res[0] & 0b10000000)
            throw new E('Invalid signature integer: negative');
        if (res[0] === 0x00 && !(res[1] & 0b10000000))
            throw new E('Invalid signature integer: unnecessary leading zero');
        return { d: b2n(res), l: data.subarray(len + 2) }; // d is data, l is left
    },
    toSig(hex) {
        // parse DER signature
        const { Err: E } = DER;
        const data = typeof hex === 'string' ? h2b(hex) : hex;
        if (!isBytes(data))
            throw new Error('ui8a expected');
        let l = data.length;
        if (l < 2 || data[0] != 0x30)
            throw new E('Invalid signature tag');
        if (data[1] !== l - 2)
            throw new E('Invalid signature: incorrect length');
        const { d: r, l: sBytes } = DER._parseInt(data.subarray(2));
        const { d: s, l: rBytesLeft } = DER._parseInt(sBytes);
        if (rBytesLeft.length)
            throw new E('Invalid signature: left bytes after parsing');
        return { r, s };
    },
    hexFromSig(sig) {
        // Add leading zero if first byte has negative bit enabled. More details in '_parseInt'
        const slice = (s) => (Number.parseInt(s[0], 16) & 0b1000 ? '00' + s : s);
        const h = (num) => {
            const hex = num.toString(16);
            return hex.length & 1 ? `0${hex}` : hex;
        };
        const s = slice(h(sig.s));
        const r = slice(h(sig.r));
        const shl = s.length / 2;
        const rhl = r.length / 2;
        const sl = h(shl);
        const rl = h(rhl);
        return `30${h(rhl + shl + 4)}02${rl}${r}02${sl}${s}`;
    },
};
// Be friendly to bad ECMAScript parsers by not using bigint literals
// prettier-ignore
const _0n$1 = BigInt(0), _1n$2 = BigInt(1); BigInt(2); const _3n = BigInt(3); BigInt(4);
function weierstrassPoints(opts) {
    const CURVE = validatePointOpts(opts);
    const { Fp } = CURVE; // All curves has same field / group length as for now, but they can differ
    const toBytes = CURVE.toBytes ||
        ((_c, point, _isCompressed) => {
            const a = point.toAffine();
            return concatBytes$1(Uint8Array.from([0x04]), Fp.toBytes(a.x), Fp.toBytes(a.y));
        });
    const fromBytes = CURVE.fromBytes ||
        ((bytes) => {
            // const head = bytes[0];
            const tail = bytes.subarray(1);
            // if (head !== 0x04) throw new Error('Only non-compressed encoding is supported');
            const x = Fp.fromBytes(tail.subarray(0, Fp.BYTES));
            const y = Fp.fromBytes(tail.subarray(Fp.BYTES, 2 * Fp.BYTES));
            return { x, y };
        });
    /**
     * y² = x³ + ax + b: Short weierstrass curve formula
     * @returns y²
     */
    function weierstrassEquation(x) {
        const { a, b } = CURVE;
        const x2 = Fp.sqr(x); // x * x
        const x3 = Fp.mul(x2, x); // x2 * x
        return Fp.add(Fp.add(x3, Fp.mul(x, a)), b); // x3 + a * x + b
    }
    // Validate whether the passed curve params are valid.
    // We check if curve equation works for generator point.
    // `assertValidity()` won't work: `isTorsionFree()` is not available at this point in bls12-381.
    // ProjectivePoint class has not been initialized yet.
    if (!Fp.eql(Fp.sqr(CURVE.Gy), weierstrassEquation(CURVE.Gx)))
        throw new Error('bad generator point: equation left != right');
    // Valid group elements reside in range 1..n-1
    function isWithinCurveOrder(num) {
        return typeof num === 'bigint' && _0n$1 < num && num < CURVE.n;
    }
    function assertGE(num) {
        if (!isWithinCurveOrder(num))
            throw new Error('Expected valid bigint: 0 < bigint < curve.n');
    }
    // Validates if priv key is valid and converts it to bigint.
    // Supports options allowedPrivateKeyLengths and wrapPrivateKey.
    function normPrivateKeyToScalar(key) {
        const { allowedPrivateKeyLengths: lengths, nByteLength, wrapPrivateKey, n } = CURVE;
        if (lengths && typeof key !== 'bigint') {
            if (isBytes(key))
                key = bytesToHex$1(key);
            // Normalize to hex string, pad. E.g. P521 would norm 130-132 char hex to 132-char bytes
            if (typeof key !== 'string' || !lengths.includes(key.length))
                throw new Error('Invalid key');
            key = key.padStart(nByteLength * 2, '0');
        }
        let num;
        try {
            num =
                typeof key === 'bigint'
                    ? key
                    : bytesToNumberBE(ensureBytes('private key', key, nByteLength));
        }
        catch (error) {
            throw new Error(`private key must be ${nByteLength} bytes, hex or bigint, not ${typeof key}`);
        }
        if (wrapPrivateKey)
            num = mod(num, n); // disabled by default, enabled for BLS
        assertGE(num); // num in range [1..N-1]
        return num;
    }
    const pointPrecomputes = new Map();
    function assertPrjPoint(other) {
        if (!(other instanceof Point))
            throw new Error('ProjectivePoint expected');
    }
    /**
     * Projective Point works in 3d / projective (homogeneous) coordinates: (x, y, z) ∋ (x=x/z, y=y/z)
     * Default Point works in 2d / affine coordinates: (x, y)
     * We're doing calculations in projective, because its operations don't require costly inversion.
     */
    class Point {
        constructor(px, py, pz) {
            this.px = px;
            this.py = py;
            this.pz = pz;
            if (px == null || !Fp.isValid(px))
                throw new Error('x required');
            if (py == null || !Fp.isValid(py))
                throw new Error('y required');
            if (pz == null || !Fp.isValid(pz))
                throw new Error('z required');
        }
        // Does not validate if the point is on-curve.
        // Use fromHex instead, or call assertValidity() later.
        static fromAffine(p) {
            const { x, y } = p || {};
            if (!p || !Fp.isValid(x) || !Fp.isValid(y))
                throw new Error('invalid affine point');
            if (p instanceof Point)
                throw new Error('projective point not allowed');
            const is0 = (i) => Fp.eql(i, Fp.ZERO);
            // fromAffine(x:0, y:0) would produce (x:0, y:0, z:1), but we need (x:0, y:1, z:0)
            if (is0(x) && is0(y))
                return Point.ZERO;
            return new Point(x, y, Fp.ONE);
        }
        get x() {
            return this.toAffine().x;
        }
        get y() {
            return this.toAffine().y;
        }
        /**
         * Takes a bunch of Projective Points but executes only one
         * inversion on all of them. Inversion is very slow operation,
         * so this improves performance massively.
         * Optimization: converts a list of projective points to a list of identical points with Z=1.
         */
        static normalizeZ(points) {
            const toInv = Fp.invertBatch(points.map((p) => p.pz));
            return points.map((p, i) => p.toAffine(toInv[i])).map(Point.fromAffine);
        }
        /**
         * Converts hash string or Uint8Array to Point.
         * @param hex short/long ECDSA hex
         */
        static fromHex(hex) {
            const P = Point.fromAffine(fromBytes(ensureBytes('pointHex', hex)));
            P.assertValidity();
            return P;
        }
        // Multiplies generator point by privateKey.
        static fromPrivateKey(privateKey) {
            return Point.BASE.multiply(normPrivateKeyToScalar(privateKey));
        }
        // "Private method", don't use it directly
        _setWindowSize(windowSize) {
            this._WINDOW_SIZE = windowSize;
            pointPrecomputes.delete(this);
        }
        // A point on curve is valid if it conforms to equation.
        assertValidity() {
            if (this.is0()) {
                // (0, 1, 0) aka ZERO is invalid in most contexts.
                // In BLS, ZERO can be serialized, so we allow it.
                // (0, 0, 0) is wrong representation of ZERO and is always invalid.
                if (CURVE.allowInfinityPoint && !Fp.is0(this.py))
                    return;
                throw new Error('bad point: ZERO');
            }
            // Some 3rd-party test vectors require different wording between here & `fromCompressedHex`
            const { x, y } = this.toAffine();
            // Check if x, y are valid field elements
            if (!Fp.isValid(x) || !Fp.isValid(y))
                throw new Error('bad point: x or y not FE');
            const left = Fp.sqr(y); // y²
            const right = weierstrassEquation(x); // x³ + ax + b
            if (!Fp.eql(left, right))
                throw new Error('bad point: equation left != right');
            if (!this.isTorsionFree())
                throw new Error('bad point: not in prime-order subgroup');
        }
        hasEvenY() {
            const { y } = this.toAffine();
            if (Fp.isOdd)
                return !Fp.isOdd(y);
            throw new Error("Field doesn't support isOdd");
        }
        /**
         * Compare one point to another.
         */
        equals(other) {
            assertPrjPoint(other);
            const { px: X1, py: Y1, pz: Z1 } = this;
            const { px: X2, py: Y2, pz: Z2 } = other;
            const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
            const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
            return U1 && U2;
        }
        /**
         * Flips point to one corresponding to (x, -y) in Affine coordinates.
         */
        negate() {
            return new Point(this.px, Fp.neg(this.py), this.pz);
        }
        // Renes-Costello-Batina exception-free doubling formula.
        // There is 30% faster Jacobian formula, but it is not complete.
        // https://eprint.iacr.org/2015/1060, algorithm 3
        // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
        double() {
            const { a, b } = CURVE;
            const b3 = Fp.mul(b, _3n);
            const { px: X1, py: Y1, pz: Z1 } = this;
            let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO; // prettier-ignore
            let t0 = Fp.mul(X1, X1); // step 1
            let t1 = Fp.mul(Y1, Y1);
            let t2 = Fp.mul(Z1, Z1);
            let t3 = Fp.mul(X1, Y1);
            t3 = Fp.add(t3, t3); // step 5
            Z3 = Fp.mul(X1, Z1);
            Z3 = Fp.add(Z3, Z3);
            X3 = Fp.mul(a, Z3);
            Y3 = Fp.mul(b3, t2);
            Y3 = Fp.add(X3, Y3); // step 10
            X3 = Fp.sub(t1, Y3);
            Y3 = Fp.add(t1, Y3);
            Y3 = Fp.mul(X3, Y3);
            X3 = Fp.mul(t3, X3);
            Z3 = Fp.mul(b3, Z3); // step 15
            t2 = Fp.mul(a, t2);
            t3 = Fp.sub(t0, t2);
            t3 = Fp.mul(a, t3);
            t3 = Fp.add(t3, Z3);
            Z3 = Fp.add(t0, t0); // step 20
            t0 = Fp.add(Z3, t0);
            t0 = Fp.add(t0, t2);
            t0 = Fp.mul(t0, t3);
            Y3 = Fp.add(Y3, t0);
            t2 = Fp.mul(Y1, Z1); // step 25
            t2 = Fp.add(t2, t2);
            t0 = Fp.mul(t2, t3);
            X3 = Fp.sub(X3, t0);
            Z3 = Fp.mul(t2, t1);
            Z3 = Fp.add(Z3, Z3); // step 30
            Z3 = Fp.add(Z3, Z3);
            return new Point(X3, Y3, Z3);
        }
        // Renes-Costello-Batina exception-free addition formula.
        // There is 30% faster Jacobian formula, but it is not complete.
        // https://eprint.iacr.org/2015/1060, algorithm 1
        // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
        add(other) {
            assertPrjPoint(other);
            const { px: X1, py: Y1, pz: Z1 } = this;
            const { px: X2, py: Y2, pz: Z2 } = other;
            let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO; // prettier-ignore
            const a = CURVE.a;
            const b3 = Fp.mul(CURVE.b, _3n);
            let t0 = Fp.mul(X1, X2); // step 1
            let t1 = Fp.mul(Y1, Y2);
            let t2 = Fp.mul(Z1, Z2);
            let t3 = Fp.add(X1, Y1);
            let t4 = Fp.add(X2, Y2); // step 5
            t3 = Fp.mul(t3, t4);
            t4 = Fp.add(t0, t1);
            t3 = Fp.sub(t3, t4);
            t4 = Fp.add(X1, Z1);
            let t5 = Fp.add(X2, Z2); // step 10
            t4 = Fp.mul(t4, t5);
            t5 = Fp.add(t0, t2);
            t4 = Fp.sub(t4, t5);
            t5 = Fp.add(Y1, Z1);
            X3 = Fp.add(Y2, Z2); // step 15
            t5 = Fp.mul(t5, X3);
            X3 = Fp.add(t1, t2);
            t5 = Fp.sub(t5, X3);
            Z3 = Fp.mul(a, t4);
            X3 = Fp.mul(b3, t2); // step 20
            Z3 = Fp.add(X3, Z3);
            X3 = Fp.sub(t1, Z3);
            Z3 = Fp.add(t1, Z3);
            Y3 = Fp.mul(X3, Z3);
            t1 = Fp.add(t0, t0); // step 25
            t1 = Fp.add(t1, t0);
            t2 = Fp.mul(a, t2);
            t4 = Fp.mul(b3, t4);
            t1 = Fp.add(t1, t2);
            t2 = Fp.sub(t0, t2); // step 30
            t2 = Fp.mul(a, t2);
            t4 = Fp.add(t4, t2);
            t0 = Fp.mul(t1, t4);
            Y3 = Fp.add(Y3, t0);
            t0 = Fp.mul(t5, t4); // step 35
            X3 = Fp.mul(t3, X3);
            X3 = Fp.sub(X3, t0);
            t0 = Fp.mul(t3, t1);
            Z3 = Fp.mul(t5, Z3);
            Z3 = Fp.add(Z3, t0); // step 40
            return new Point(X3, Y3, Z3);
        }
        subtract(other) {
            return this.add(other.negate());
        }
        is0() {
            return this.equals(Point.ZERO);
        }
        wNAF(n) {
            return wnaf.wNAFCached(this, pointPrecomputes, n, (comp) => {
                const toInv = Fp.invertBatch(comp.map((p) => p.pz));
                return comp.map((p, i) => p.toAffine(toInv[i])).map(Point.fromAffine);
            });
        }
        /**
         * Non-constant-time multiplication. Uses double-and-add algorithm.
         * It's faster, but should only be used when you don't care about
         * an exposed private key e.g. sig verification, which works over *public* keys.
         */
        multiplyUnsafe(n) {
            const I = Point.ZERO;
            if (n === _0n$1)
                return I;
            assertGE(n); // Will throw on 0
            if (n === _1n$2)
                return this;
            const { endo } = CURVE;
            if (!endo)
                return wnaf.unsafeLadder(this, n);
            // Apply endomorphism
            let { k1neg, k1, k2neg, k2 } = endo.splitScalar(n);
            let k1p = I;
            let k2p = I;
            let d = this;
            while (k1 > _0n$1 || k2 > _0n$1) {
                if (k1 & _1n$2)
                    k1p = k1p.add(d);
                if (k2 & _1n$2)
                    k2p = k2p.add(d);
                d = d.double();
                k1 >>= _1n$2;
                k2 >>= _1n$2;
            }
            if (k1neg)
                k1p = k1p.negate();
            if (k2neg)
                k2p = k2p.negate();
            k2p = new Point(Fp.mul(k2p.px, endo.beta), k2p.py, k2p.pz);
            return k1p.add(k2p);
        }
        /**
         * Constant time multiplication.
         * Uses wNAF method. Windowed method may be 10% faster,
         * but takes 2x longer to generate and consumes 2x memory.
         * Uses precomputes when available.
         * Uses endomorphism for Koblitz curves.
         * @param scalar by which the point would be multiplied
         * @returns New point
         */
        multiply(scalar) {
            assertGE(scalar);
            let n = scalar;
            let point, fake; // Fake point is used to const-time mult
            const { endo } = CURVE;
            if (endo) {
                const { k1neg, k1, k2neg, k2 } = endo.splitScalar(n);
                let { p: k1p, f: f1p } = this.wNAF(k1);
                let { p: k2p, f: f2p } = this.wNAF(k2);
                k1p = wnaf.constTimeNegate(k1neg, k1p);
                k2p = wnaf.constTimeNegate(k2neg, k2p);
                k2p = new Point(Fp.mul(k2p.px, endo.beta), k2p.py, k2p.pz);
                point = k1p.add(k2p);
                fake = f1p.add(f2p);
            }
            else {
                const { p, f } = this.wNAF(n);
                point = p;
                fake = f;
            }
            // Normalize `z` for both points, but return only real one
            return Point.normalizeZ([point, fake])[0];
        }
        /**
         * Efficiently calculate `aP + bQ`. Unsafe, can expose private key, if used incorrectly.
         * Not using Strauss-Shamir trick: precomputation tables are faster.
         * The trick could be useful if both P and Q are not G (not in our case).
         * @returns non-zero affine point
         */
        multiplyAndAddUnsafe(Q, a, b) {
            const G = Point.BASE; // No Strauss-Shamir trick: we have 10% faster G precomputes
            const mul = (P, a // Select faster multiply() method
            ) => (a === _0n$1 || a === _1n$2 || !P.equals(G) ? P.multiplyUnsafe(a) : P.multiply(a));
            const sum = mul(this, a).add(mul(Q, b));
            return sum.is0() ? undefined : sum;
        }
        // Converts Projective point to affine (x, y) coordinates.
        // Can accept precomputed Z^-1 - for example, from invertBatch.
        // (x, y, z) ∋ (x=x/z, y=y/z)
        toAffine(iz) {
            const { px: x, py: y, pz: z } = this;
            const is0 = this.is0();
            // If invZ was 0, we return zero point. However we still want to execute
            // all operations, so we replace invZ with a random number, 1.
            if (iz == null)
                iz = is0 ? Fp.ONE : Fp.inv(z);
            const ax = Fp.mul(x, iz);
            const ay = Fp.mul(y, iz);
            const zz = Fp.mul(z, iz);
            if (is0)
                return { x: Fp.ZERO, y: Fp.ZERO };
            if (!Fp.eql(zz, Fp.ONE))
                throw new Error('invZ was invalid');
            return { x: ax, y: ay };
        }
        isTorsionFree() {
            const { h: cofactor, isTorsionFree } = CURVE;
            if (cofactor === _1n$2)
                return true; // No subgroups, always torsion-free
            if (isTorsionFree)
                return isTorsionFree(Point, this);
            throw new Error('isTorsionFree() has not been declared for the elliptic curve');
        }
        clearCofactor() {
            const { h: cofactor, clearCofactor } = CURVE;
            if (cofactor === _1n$2)
                return this; // Fast-path
            if (clearCofactor)
                return clearCofactor(Point, this);
            return this.multiplyUnsafe(CURVE.h);
        }
        toRawBytes(isCompressed = true) {
            this.assertValidity();
            return toBytes(Point, this, isCompressed);
        }
        toHex(isCompressed = true) {
            return bytesToHex$1(this.toRawBytes(isCompressed));
        }
    }
    Point.BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
    Point.ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
    const _bits = CURVE.nBitLength;
    const wnaf = wNAF(Point, CURVE.endo ? Math.ceil(_bits / 2) : _bits);
    // Validate if generator point is on curve
    return {
        CURVE,
        ProjectivePoint: Point,
        normPrivateKeyToScalar,
        weierstrassEquation,
        isWithinCurveOrder,
    };
}
function validateOpts(curve) {
    const opts = validateBasic(curve);
    validateObject(opts, {
        hash: 'hash',
        hmac: 'function',
        randomBytes: 'function',
    }, {
        bits2int: 'function',
        bits2int_modN: 'function',
        lowS: 'boolean',
    });
    return Object.freeze({ lowS: true, ...opts });
}
function weierstrass(curveDef) {
    const CURVE = validateOpts(curveDef);
    const { Fp, n: CURVE_ORDER } = CURVE;
    const compressedLen = Fp.BYTES + 1; // e.g. 33 for 32
    const uncompressedLen = 2 * Fp.BYTES + 1; // e.g. 65 for 32
    function isValidFieldElement(num) {
        return _0n$1 < num && num < Fp.ORDER; // 0 is banned since it's not invertible FE
    }
    function modN(a) {
        return mod(a, CURVE_ORDER);
    }
    function invN(a) {
        return invert(a, CURVE_ORDER);
    }
    const { ProjectivePoint: Point, normPrivateKeyToScalar, weierstrassEquation, isWithinCurveOrder, } = weierstrassPoints({
        ...CURVE,
        toBytes(_c, point, isCompressed) {
            const a = point.toAffine();
            const x = Fp.toBytes(a.x);
            const cat = concatBytes$1;
            if (isCompressed) {
                return cat(Uint8Array.from([point.hasEvenY() ? 0x02 : 0x03]), x);
            }
            else {
                return cat(Uint8Array.from([0x04]), x, Fp.toBytes(a.y));
            }
        },
        fromBytes(bytes) {
            const len = bytes.length;
            const head = bytes[0];
            const tail = bytes.subarray(1);
            // this.assertValidity() is done inside of fromHex
            if (len === compressedLen && (head === 0x02 || head === 0x03)) {
                const x = bytesToNumberBE(tail);
                if (!isValidFieldElement(x))
                    throw new Error('Point is not on curve');
                const y2 = weierstrassEquation(x); // y² = x³ + ax + b
                let y = Fp.sqrt(y2); // y = y² ^ (p+1)/4
                const isYOdd = (y & _1n$2) === _1n$2;
                // ECDSA
                const isHeadOdd = (head & 1) === 1;
                if (isHeadOdd !== isYOdd)
                    y = Fp.neg(y);
                return { x, y };
            }
            else if (len === uncompressedLen && head === 0x04) {
                const x = Fp.fromBytes(tail.subarray(0, Fp.BYTES));
                const y = Fp.fromBytes(tail.subarray(Fp.BYTES, 2 * Fp.BYTES));
                return { x, y };
            }
            else {
                throw new Error(`Point of length ${len} was invalid. Expected ${compressedLen} compressed bytes or ${uncompressedLen} uncompressed bytes`);
            }
        },
    });
    const numToNByteStr = (num) => bytesToHex$1(numberToBytesBE(num, CURVE.nByteLength));
    function isBiggerThanHalfOrder(number) {
        const HALF = CURVE_ORDER >> _1n$2;
        return number > HALF;
    }
    function normalizeS(s) {
        return isBiggerThanHalfOrder(s) ? modN(-s) : s;
    }
    // slice bytes num
    const slcNum = (b, from, to) => bytesToNumberBE(b.slice(from, to));
    /**
     * ECDSA signature with its (r, s) properties. Supports DER & compact representations.
     */
    class Signature {
        constructor(r, s, recovery) {
            this.r = r;
            this.s = s;
            this.recovery = recovery;
            this.assertValidity();
        }
        // pair (bytes of r, bytes of s)
        static fromCompact(hex) {
            const l = CURVE.nByteLength;
            hex = ensureBytes('compactSignature', hex, l * 2);
            return new Signature(slcNum(hex, 0, l), slcNum(hex, l, 2 * l));
        }
        // DER encoded ECDSA signature
        // https://bitcoin.stackexchange.com/questions/57644/what-are-the-parts-of-a-bitcoin-transaction-input-script
        static fromDER(hex) {
            const { r, s } = DER.toSig(ensureBytes('DER', hex));
            return new Signature(r, s);
        }
        assertValidity() {
            // can use assertGE here
            if (!isWithinCurveOrder(this.r))
                throw new Error('r must be 0 < r < CURVE.n');
            if (!isWithinCurveOrder(this.s))
                throw new Error('s must be 0 < s < CURVE.n');
        }
        addRecoveryBit(recovery) {
            return new Signature(this.r, this.s, recovery);
        }
        recoverPublicKey(msgHash) {
            const { r, s, recovery: rec } = this;
            const h = bits2int_modN(ensureBytes('msgHash', msgHash)); // Truncate hash
            if (rec == null || ![0, 1, 2, 3].includes(rec))
                throw new Error('recovery id invalid');
            const radj = rec === 2 || rec === 3 ? r + CURVE.n : r;
            if (radj >= Fp.ORDER)
                throw new Error('recovery id 2 or 3 invalid');
            const prefix = (rec & 1) === 0 ? '02' : '03';
            const R = Point.fromHex(prefix + numToNByteStr(radj));
            const ir = invN(radj); // r^-1
            const u1 = modN(-h * ir); // -hr^-1
            const u2 = modN(s * ir); // sr^-1
            const Q = Point.BASE.multiplyAndAddUnsafe(R, u1, u2); // (sr^-1)R-(hr^-1)G = -(hr^-1)G + (sr^-1)
            if (!Q)
                throw new Error('point at infinify'); // unsafe is fine: no priv data leaked
            Q.assertValidity();
            return Q;
        }
        // Signatures should be low-s, to prevent malleability.
        hasHighS() {
            return isBiggerThanHalfOrder(this.s);
        }
        normalizeS() {
            return this.hasHighS() ? new Signature(this.r, modN(-this.s), this.recovery) : this;
        }
        // DER-encoded
        toDERRawBytes() {
            return hexToBytes$1(this.toDERHex());
        }
        toDERHex() {
            return DER.hexFromSig({ r: this.r, s: this.s });
        }
        // padded bytes of r, then padded bytes of s
        toCompactRawBytes() {
            return hexToBytes$1(this.toCompactHex());
        }
        toCompactHex() {
            return numToNByteStr(this.r) + numToNByteStr(this.s);
        }
    }
    const utils = {
        isValidPrivateKey(privateKey) {
            try {
                normPrivateKeyToScalar(privateKey);
                return true;
            }
            catch (error) {
                return false;
            }
        },
        normPrivateKeyToScalar: normPrivateKeyToScalar,
        /**
         * Produces cryptographically secure private key from random of size
         * (groupLen + ceil(groupLen / 2)) with modulo bias being negligible.
         */
        randomPrivateKey: () => {
            const length = getMinHashLength(CURVE.n);
            return mapHashToField(CURVE.randomBytes(length), CURVE.n);
        },
        /**
         * Creates precompute table for an arbitrary EC point. Makes point "cached".
         * Allows to massively speed-up `point.multiply(scalar)`.
         * @returns cached point
         * @example
         * const fast = utils.precompute(8, ProjectivePoint.fromHex(someonesPubKey));
         * fast.multiply(privKey); // much faster ECDH now
         */
        precompute(windowSize = 8, point = Point.BASE) {
            point._setWindowSize(windowSize);
            point.multiply(BigInt(3)); // 3 is arbitrary, just need any number here
            return point;
        },
    };
    /**
     * Computes public key for a private key. Checks for validity of the private key.
     * @param privateKey private key
     * @param isCompressed whether to return compact (default), or full key
     * @returns Public key, full when isCompressed=false; short when isCompressed=true
     */
    function getPublicKey(privateKey, isCompressed = true) {
        return Point.fromPrivateKey(privateKey).toRawBytes(isCompressed);
    }
    /**
     * Quick and dirty check for item being public key. Does not validate hex, or being on-curve.
     */
    function isProbPub(item) {
        const arr = isBytes(item);
        const str = typeof item === 'string';
        const len = (arr || str) && item.length;
        if (arr)
            return len === compressedLen || len === uncompressedLen;
        if (str)
            return len === 2 * compressedLen || len === 2 * uncompressedLen;
        if (item instanceof Point)
            return true;
        return false;
    }
    /**
     * ECDH (Elliptic Curve Diffie Hellman).
     * Computes shared public key from private key and public key.
     * Checks: 1) private key validity 2) shared key is on-curve.
     * Does NOT hash the result.
     * @param privateA private key
     * @param publicB different public key
     * @param isCompressed whether to return compact (default), or full key
     * @returns shared public key
     */
    function getSharedSecret(privateA, publicB, isCompressed = true) {
        if (isProbPub(privateA))
            throw new Error('first arg must be private key');
        if (!isProbPub(publicB))
            throw new Error('second arg must be public key');
        const b = Point.fromHex(publicB); // check for being on-curve
        return b.multiply(normPrivateKeyToScalar(privateA)).toRawBytes(isCompressed);
    }
    // RFC6979: ensure ECDSA msg is X bytes and < N. RFC suggests optional truncating via bits2octets.
    // FIPS 186-4 4.6 suggests the leftmost min(nBitLen, outLen) bits, which matches bits2int.
    // bits2int can produce res>N, we can do mod(res, N) since the bitLen is the same.
    // int2octets can't be used; pads small msgs with 0: unacceptatble for trunc as per RFC vectors
    const bits2int = CURVE.bits2int ||
        function (bytes) {
            // For curves with nBitLength % 8 !== 0: bits2octets(bits2octets(m)) !== bits2octets(m)
            // for some cases, since bytes.length * 8 is not actual bitLength.
            const num = bytesToNumberBE(bytes); // check for == u8 done here
            const delta = bytes.length * 8 - CURVE.nBitLength; // truncate to nBitLength leftmost bits
            return delta > 0 ? num >> BigInt(delta) : num;
        };
    const bits2int_modN = CURVE.bits2int_modN ||
        function (bytes) {
            return modN(bits2int(bytes)); // can't use bytesToNumberBE here
        };
    // NOTE: pads output with zero as per spec
    const ORDER_MASK = bitMask(CURVE.nBitLength);
    /**
     * Converts to bytes. Checks if num in `[0..ORDER_MASK-1]` e.g.: `[0..2^256-1]`.
     */
    function int2octets(num) {
        if (typeof num !== 'bigint')
            throw new Error('bigint expected');
        if (!(_0n$1 <= num && num < ORDER_MASK))
            throw new Error(`bigint expected < 2^${CURVE.nBitLength}`);
        // works with order, can have different size than numToField!
        return numberToBytesBE(num, CURVE.nByteLength);
    }
    // Steps A, D of RFC6979 3.2
    // Creates RFC6979 seed; converts msg/privKey to numbers.
    // Used only in sign, not in verify.
    // NOTE: we cannot assume here that msgHash has same amount of bytes as curve order, this will be wrong at least for P521.
    // Also it can be bigger for P224 + SHA256
    function prepSig(msgHash, privateKey, opts = defaultSigOpts) {
        if (['recovered', 'canonical'].some((k) => k in opts))
            throw new Error('sign() legacy options not supported');
        const { hash, randomBytes } = CURVE;
        let { lowS, prehash, extraEntropy: ent } = opts; // generates low-s sigs by default
        if (lowS == null)
            lowS = true; // RFC6979 3.2: we skip step A, because we already provide hash
        msgHash = ensureBytes('msgHash', msgHash);
        if (prehash)
            msgHash = ensureBytes('prehashed msgHash', hash(msgHash));
        // We can't later call bits2octets, since nested bits2int is broken for curves
        // with nBitLength % 8 !== 0. Because of that, we unwrap it here as int2octets call.
        // const bits2octets = (bits) => int2octets(bits2int_modN(bits))
        const h1int = bits2int_modN(msgHash);
        const d = normPrivateKeyToScalar(privateKey); // validate private key, convert to bigint
        const seedArgs = [int2octets(d), int2octets(h1int)];
        // extraEntropy. RFC6979 3.6: additional k' (optional).
        if (ent != null) {
            // K = HMAC_K(V || 0x00 || int2octets(x) || bits2octets(h1) || k')
            const e = ent === true ? randomBytes(Fp.BYTES) : ent; // generate random bytes OR pass as-is
            seedArgs.push(ensureBytes('extraEntropy', e)); // check for being bytes
        }
        const seed = concatBytes$1(...seedArgs); // Step D of RFC6979 3.2
        const m = h1int; // NOTE: no need to call bits2int second time here, it is inside truncateHash!
        // Converts signature params into point w r/s, checks result for validity.
        function k2sig(kBytes) {
            // RFC 6979 Section 3.2, step 3: k = bits2int(T)
            const k = bits2int(kBytes); // Cannot use fields methods, since it is group element
            if (!isWithinCurveOrder(k))
                return; // Important: all mod() calls here must be done over N
            const ik = invN(k); // k^-1 mod n
            const q = Point.BASE.multiply(k).toAffine(); // q = Gk
            const r = modN(q.x); // r = q.x mod n
            if (r === _0n$1)
                return;
            // Can use scalar blinding b^-1(bm + bdr) where b ∈ [1,q−1] according to
            // https://tches.iacr.org/index.php/TCHES/article/view/7337/6509. We've decided against it:
            // a) dependency on CSPRNG b) 15% slowdown c) doesn't really help since bigints are not CT
            const s = modN(ik * modN(m + r * d)); // Not using blinding here
            if (s === _0n$1)
                return;
            let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n$2); // recovery bit (2 or 3, when q.x > n)
            let normS = s;
            if (lowS && isBiggerThanHalfOrder(s)) {
                normS = normalizeS(s); // if lowS was passed, ensure s is always
                recovery ^= 1; // // in the bottom half of N
            }
            return new Signature(r, normS, recovery); // use normS, not s
        }
        return { seed, k2sig };
    }
    const defaultSigOpts = { lowS: CURVE.lowS, prehash: false };
    const defaultVerOpts = { lowS: CURVE.lowS, prehash: false };
    /**
     * Signs message hash with a private key.
     * ```
     * sign(m, d, k) where
     *   (x, y) = G × k
     *   r = x mod n
     *   s = (m + dr)/k mod n
     * ```
     * @param msgHash NOT message. msg needs to be hashed to `msgHash`, or use `prehash`.
     * @param privKey private key
     * @param opts lowS for non-malleable sigs. extraEntropy for mixing randomness into k. prehash will hash first arg.
     * @returns signature with recovery param
     */
    function sign(msgHash, privKey, opts = defaultSigOpts) {
        const { seed, k2sig } = prepSig(msgHash, privKey, opts); // Steps A, D of RFC6979 3.2.
        const C = CURVE;
        const drbg = createHmacDrbg(C.hash.outputLen, C.nByteLength, C.hmac);
        return drbg(seed, k2sig); // Steps B, C, D, E, F, G
    }
    // Enable precomputes. Slows down first publicKey computation by 20ms.
    Point.BASE._setWindowSize(8);
    // utils.precompute(8, ProjectivePoint.BASE)
    /**
     * Verifies a signature against message hash and public key.
     * Rejects lowS signatures by default: to override,
     * specify option `{lowS: false}`. Implements section 4.1.4 from https://www.secg.org/sec1-v2.pdf:
     *
     * ```
     * verify(r, s, h, P) where
     *   U1 = hs^-1 mod n
     *   U2 = rs^-1 mod n
     *   R = U1⋅G - U2⋅P
     *   mod(R.x, n) == r
     * ```
     */
    function verify(signature, msgHash, publicKey, opts = defaultVerOpts) {
        const sg = signature;
        msgHash = ensureBytes('msgHash', msgHash);
        publicKey = ensureBytes('publicKey', publicKey);
        if ('strict' in opts)
            throw new Error('options.strict was renamed to lowS');
        const { lowS, prehash } = opts;
        let _sig = undefined;
        let P;
        try {
            if (typeof sg === 'string' || isBytes(sg)) {
                // Signature can be represented in 2 ways: compact (2*nByteLength) & DER (variable-length).
                // Since DER can also be 2*nByteLength bytes, we check for it first.
                try {
                    _sig = Signature.fromDER(sg);
                }
                catch (derError) {
                    if (!(derError instanceof DER.Err))
                        throw derError;
                    _sig = Signature.fromCompact(sg);
                }
            }
            else if (typeof sg === 'object' && typeof sg.r === 'bigint' && typeof sg.s === 'bigint') {
                const { r, s } = sg;
                _sig = new Signature(r, s);
            }
            else {
                throw new Error('PARSE');
            }
            P = Point.fromHex(publicKey);
        }
        catch (error) {
            if (error.message === 'PARSE')
                throw new Error(`signature must be Signature instance, Uint8Array or hex string`);
            return false;
        }
        if (lowS && _sig.hasHighS())
            return false;
        if (prehash)
            msgHash = CURVE.hash(msgHash);
        const { r, s } = _sig;
        const h = bits2int_modN(msgHash); // Cannot use fields methods, since it is group element
        const is = invN(s); // s^-1
        const u1 = modN(h * is); // u1 = hs^-1 mod n
        const u2 = modN(r * is); // u2 = rs^-1 mod n
        const R = Point.BASE.multiplyAndAddUnsafe(P, u1, u2)?.toAffine(); // R = u1⋅G + u2⋅P
        if (!R)
            return false;
        const v = modN(R.x);
        return v === r;
    }
    return {
        CURVE,
        getPublicKey,
        getSharedSecret,
        sign,
        verify,
        ProjectivePoint: Point,
        Signature,
        utils,
    };
}

// HMAC (RFC 2104)
class HMAC extends Hash {
    constructor(hash, _key) {
        super();
        this.finished = false;
        this.destroyed = false;
        hash$1(hash);
        const key = toBytes$1(_key);
        this.iHash = hash.create();
        if (typeof this.iHash.update !== 'function')
            throw new Error('Expected instance of class which extends utils.Hash');
        this.blockLen = this.iHash.blockLen;
        this.outputLen = this.iHash.outputLen;
        const blockLen = this.blockLen;
        const pad = new Uint8Array(blockLen);
        // blockLen can be bigger than outputLen
        pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
        for (let i = 0; i < pad.length; i++)
            pad[i] ^= 0x36;
        this.iHash.update(pad);
        // By doing update (processing of first block) of outer hash here we can re-use it between multiple calls via clone
        this.oHash = hash.create();
        // Undo internal XOR && apply outer XOR
        for (let i = 0; i < pad.length; i++)
            pad[i] ^= 0x36 ^ 0x5c;
        this.oHash.update(pad);
        pad.fill(0);
    }
    update(buf) {
        exists(this);
        this.iHash.update(buf);
        return this;
    }
    digestInto(out) {
        exists(this);
        bytes(out, this.outputLen);
        this.finished = true;
        this.iHash.digestInto(out);
        this.oHash.update(out);
        this.oHash.digestInto(out);
        this.destroy();
    }
    digest() {
        const out = new Uint8Array(this.oHash.outputLen);
        this.digestInto(out);
        return out;
    }
    _cloneInto(to) {
        // Create new instance without calling constructor since key already in state and we don't know it.
        to || (to = Object.create(Object.getPrototypeOf(this), {}));
        const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
        to = to;
        to.finished = finished;
        to.destroyed = destroyed;
        to.blockLen = blockLen;
        to.outputLen = outputLen;
        to.oHash = oHash._cloneInto(to.oHash);
        to.iHash = iHash._cloneInto(to.iHash);
        return to;
    }
    destroy() {
        this.destroyed = true;
        this.oHash.destroy();
        this.iHash.destroy();
    }
}
/**
 * HMAC: RFC2104 message authentication code.
 * @param hash - function that would be used e.g. sha256
 * @param key - message key
 * @param message - message data
 */
const hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new HMAC(hash, key);

/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// connects noble-curves to noble-hashes
function getHash(hash) {
    return {
        hash,
        hmac: (key, ...msgs) => hmac(hash, key, concatBytes$2(...msgs)),
        randomBytes,
    };
}
function createCurve(curveDef, defHash) {
    const create = (hash) => weierstrass({ ...curveDef, ...getHash(hash) });
    return Object.freeze({ ...create(defHash), create });
}

/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const secp256k1P = BigInt('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f');
const secp256k1N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const _1n$1 = BigInt(1);
const _2n$1 = BigInt(2);
const divNearest = (a, b) => (a + b / _2n$1) / b;
/**
 * √n = n^((p+1)/4) for fields p = 3 mod 4. We unwrap the loop and multiply bit-by-bit.
 * (P+1n/4n).toString(2) would produce bits [223x 1, 0, 22x 1, 4x 0, 11, 00]
 */
function sqrtMod(y) {
    const P = secp256k1P;
    // prettier-ignore
    const _3n = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
    // prettier-ignore
    const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
    const b2 = (y * y * y) % P; // x^3, 11
    const b3 = (b2 * b2 * y) % P; // x^7
    const b6 = (pow2(b3, _3n, P) * b3) % P;
    const b9 = (pow2(b6, _3n, P) * b3) % P;
    const b11 = (pow2(b9, _2n$1, P) * b2) % P;
    const b22 = (pow2(b11, _11n, P) * b11) % P;
    const b44 = (pow2(b22, _22n, P) * b22) % P;
    const b88 = (pow2(b44, _44n, P) * b44) % P;
    const b176 = (pow2(b88, _88n, P) * b88) % P;
    const b220 = (pow2(b176, _44n, P) * b44) % P;
    const b223 = (pow2(b220, _3n, P) * b3) % P;
    const t1 = (pow2(b223, _23n, P) * b22) % P;
    const t2 = (pow2(t1, _6n, P) * b2) % P;
    const root = pow2(t2, _2n$1, P);
    if (!Fp.eql(Fp.sqr(root), y))
        throw new Error('Cannot find square root');
    return root;
}
const Fp = Field(secp256k1P, undefined, undefined, { sqrt: sqrtMod });
const secp256k1 = createCurve({
    a: BigInt(0), // equation params: a, b
    b: BigInt(7), // Seem to be rigid: bitcointalk.org/index.php?topic=289795.msg3183975#msg3183975
    Fp, // Field's prime: 2n**256n - 2n**32n - 2n**9n - 2n**8n - 2n**7n - 2n**6n - 2n**4n - 1n
    n: secp256k1N, // Curve order, total count of valid points in the field
    // Base point (x, y) aka generator point
    Gx: BigInt('55066263022277343669578718895168534326250603453777594175500187360389116729240'),
    Gy: BigInt('32670510020758816978083085130507043184471273380659243275938904335757337482424'),
    h: BigInt(1), // Cofactor
    lowS: true, // Allow only low-S signatures by default in sign() and verify()
    /**
     * secp256k1 belongs to Koblitz curves: it has efficiently computable endomorphism.
     * Endomorphism uses 2x less RAM, speeds up precomputation by 2x and ECDH / key recovery by 20%.
     * For precomputed wNAF it trades off 1/2 init time & 1/3 ram for 20% perf hit.
     * Explanation: https://gist.github.com/paulmillr/eb670806793e84df628a7c434a873066
     */
    endo: {
        beta: BigInt('0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee'),
        splitScalar: (k) => {
            const n = secp256k1N;
            const a1 = BigInt('0x3086d221a7d46bcde86c90e49284eb15');
            const b1 = -_1n$1 * BigInt('0xe4437ed6010e88286f547fa90abfe4c3');
            const a2 = BigInt('0x114ca50f7a8e2f3f657c1108d9d44cfd8');
            const b2 = a1;
            const POW_2_128 = BigInt('0x100000000000000000000000000000000'); // (2n**128n).toString(16)
            const c1 = divNearest(b2 * k, n);
            const c2 = divNearest(-b1 * k, n);
            let k1 = mod(k - c1 * a1 - c2 * a2, n);
            let k2 = mod(-c1 * b1 - c2 * b2, n);
            const k1neg = k1 > POW_2_128;
            const k2neg = k2 > POW_2_128;
            if (k1neg)
                k1 = n - k1;
            if (k2neg)
                k2 = n - k2;
            if (k1 > POW_2_128 || k2 > POW_2_128) {
                throw new Error('splitScalar: Endomorphism failed, k=' + k);
            }
            return { k1neg, k1, k2neg, k2 };
        },
    },
}, sha256$1);
// Schnorr signatures are superior to ECDSA from above. Below is Schnorr-specific BIP0340 code.
// https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki
BigInt(0);
secp256k1.ProjectivePoint;

// buf.equals(buf2) -> equalsBytes(buf, buf2)
function equalsBytes(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}
// Internal utils
function wrapHash(hash) {
    return (msg) => {
        assert.bytes(msg);
        return hash(msg);
    };
}
// TODO(v3): switch away from node crypto, remove this unnecessary variable.
(() => {
    const webCrypto = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : undefined;
    const nodeRequire = typeof module !== "undefined" &&
        typeof module.require === "function" &&
        module.require.bind(module);
    return {
        node: nodeRequire && !webCrypto ? nodeRequire("crypto") : undefined,
        web: webCrypto
    };
})();

/*
The MIT License

Copyright (c) 2016 Nick Dodson. nickdodson.com

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE
 */
/**
 * Returns a `Boolean` on whether or not the a `String` starts with '0x'
 * @param str the string input value
 * @return a boolean if it is or is not hex prefixed
 * @throws if the str input is not a string
 */
function isHexPrefixed(str) {
    if (typeof str !== 'string') {
        throw new Error(`[isHexPrefixed] input must be type 'string', received type ${typeof str}`);
    }
    return str[0] === '0' && str[1] === 'x';
}
/**
 * Removes '0x' from a given `String` if present
 * @param str the string value
 * @returns the string without 0x prefix
 */
const stripHexPrefix = (str) => {
    if (typeof str !== 'string')
        throw new Error(`[stripHexPrefix] input must be type 'string', received ${typeof str}`);
    return isHexPrefixed(str) ? str.slice(2) : str;
};
/**
 * Pads a `String` to have an even length
 * @param value
 * @return output
 */
function padToEven(value) {
    let a = value;
    if (typeof a !== 'string') {
        throw new Error(`[padToEven] value must be type 'string', received ${typeof a}`);
    }
    if (a.length % 2)
        a = `0${a}`;
    return a;
}
/**
 * Is the string a hex string.
 *
 * @param  value
 * @param  length
 * @returns  output the string is a hex string
 */
function isHexString(value, length) {
    if (typeof value !== 'string' || !value.match(/^0x[0-9A-Fa-f]*$/))
        return false;
    if (typeof length !== 'undefined' && length > 0 && value.length !== 2 + 2 * length)
        return false;
    return true;
}

/**
 * Throws if input is not a buffer
 * @param {Buffer} input value to check
 */
const assertIsBytes = function (input) {
    if (!(input instanceof Uint8Array)) {
        const msg = `This method only supports Uint8Array but input was: ${input}`;
        throw new Error(msg);
    }
};
/**
 * Throws if input is not a string
 * @param {string} input value to check
 */
const assertIsString = function (input) {
    if (typeof input !== 'string') {
        const msg = `This method only supports strings but input was: ${input}`;
        throw new Error(msg);
    }
};

const BIGINT_0$1 = BigInt(0);
// hexToBytes cache
const hexToBytesMapFirstKey = {};
const hexToBytesMapSecondKey = {};
for (let i = 0; i < 16; i++) {
    const vSecondKey = i;
    const vFirstKey = i * 16;
    const key = i.toString(16).toLowerCase();
    hexToBytesMapSecondKey[key] = vSecondKey;
    hexToBytesMapSecondKey[key.toUpperCase()] = vSecondKey;
    hexToBytesMapFirstKey[key] = vFirstKey;
    hexToBytesMapFirstKey[key.toUpperCase()] = vFirstKey;
}
/**
 * NOTE: only use this function if the string is even, and only consists of hex characters
 * If this is not the case, this function could return weird results
 * @deprecated
 */
function _unprefixedHexToBytes(hex) {
    const byteLen = hex.length;
    const bytes = new Uint8Array(byteLen / 2);
    for (let i = 0; i < byteLen; i += 2) {
        bytes[i / 2] = hexToBytesMapFirstKey[hex[i]] + hexToBytesMapSecondKey[hex[i + 1]];
    }
    return bytes;
}
/**
 * @deprecated
 */
const unprefixedHexToBytes = (inp) => {
    if (inp.slice(0, 2) === '0x') {
        throw new Error('hex string is prefixed with 0x, should be unprefixed');
    }
    else {
        return _unprefixedHexToBytes(padToEven(inp));
    }
};
/****************  Borrowed from @chainsafe/ssz */
// Caching this info costs about ~1000 bytes and speeds up toHexString() by x6
const hexByByte = Array.from({ length: 256 }, (v, i) => i.toString(16).padStart(2, '0'));
const bytesToHex = (bytes) => {
    let hex = '0x';
    if (bytes === undefined || bytes.length === 0)
        return hex;
    for (const byte of bytes) {
        hex += hexByByte[byte];
    }
    return hex;
};
// BigInt cache for the numbers 0 - 256*256-1 (two-byte bytes)
const BIGINT_CACHE = [];
for (let i = 0; i <= 256 * 256 - 1; i++) {
    BIGINT_CACHE[i] = BigInt(i);
}
/**
 * Converts a {@link Uint8Array} to a {@link bigint}
 * @param {Uint8Array} bytes the bytes to convert
 * @returns {bigint}
 */
const bytesToBigInt = (bytes, littleEndian = false) => {
    if (littleEndian) {
        bytes.reverse();
    }
    const hex = bytesToHex(bytes);
    if (hex === '0x') {
        return BIGINT_0$1;
    }
    if (hex.length === 4) {
        // If the byte length is 1 (this is faster than checking `bytes.length === 1`)
        return BIGINT_CACHE[bytes[0]];
    }
    if (hex.length === 6) {
        return BIGINT_CACHE[bytes[0] * 256 + bytes[1]];
    }
    return BigInt(hex);
};
const hexToBytes = (hex) => {
    if (typeof hex !== 'string') {
        throw new Error(`hex argument type ${typeof hex} must be of type string`);
    }
    if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
        throw new Error(`Input must be a 0x-prefixed hexadecimal string, got ${hex}`);
    }
    hex = hex.slice(2);
    if (hex.length % 2 !== 0) {
        hex = padToEven(hex);
    }
    return _unprefixedHexToBytes(hex);
};
/******************************************/
/**
 * Converts a {@link number} into a {@link PrefixedHexString}
 * @param {number} i
 * @return {PrefixedHexString}
 */
const intToHex = (i) => {
    if (!Number.isSafeInteger(i) || i < 0) {
        throw new Error(`Received an invalid integer type: ${i}`);
    }
    return `0x${i.toString(16)}`;
};
/**
 * Converts an {@link number} to a {@link Uint8Array}
 * @param {Number} i
 * @return {Uint8Array}
 */
const intToBytes = (i) => {
    const hex = intToHex(i);
    return hexToBytes(hex);
};
/**
 * Converts a {@link bigint} to a {@link Uint8Array}
 *  * @param {bigint} num the bigint to convert
 * @returns {Uint8Array}
 */
const bigIntToBytes = (num, littleEndian = false) => {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const bytes = toBytes('0x' + padToEven(num.toString(16)));
    return littleEndian ? bytes.reverse() : bytes;
};
/**
 * Returns a Uint8Array filled with 0s.
 * @param {number} bytes the number of bytes of the Uint8Array
 * @return {Uint8Array}
 */
const zeros = (bytes) => {
    return new Uint8Array(bytes);
};
/**
 * Pads a `Uint8Array` with zeros till it has `length` bytes.
 * Truncates the beginning or end of input if its length exceeds `length`.
 * @param {Uint8Array} msg the value to pad
 * @param {number} length the number of bytes the output should be
 * @param {boolean} right whether to start padding form the left or right
 * @return {Uint8Array}
 */
const setLength = (msg, length, right) => {
    if (right) {
        if (msg.length < length) {
            return new Uint8Array([...msg, ...zeros(length - msg.length)]);
        }
        return msg.subarray(0, length);
    }
    else {
        if (msg.length < length) {
            return new Uint8Array([...zeros(length - msg.length), ...msg]);
        }
        return msg.subarray(-length);
    }
};
/**
 * Left Pads a `Uint8Array` with leading zeros till it has `length` bytes.
 * Or it truncates the beginning if it exceeds.
 * @param {Uint8Array} msg the value to pad
 * @param {number} length the number of bytes the output should be
 * @return {Uint8Array}
 */
const setLengthLeft = (msg, length) => {
    assertIsBytes(msg);
    return setLength(msg, length, false);
};
/**
 * Trims leading zeros from a `Uint8Array`, `number[]` or PrefixedHexString`.
 * @param {Uint8Array|number[]|PrefixedHexString} a
 * @return {Uint8Array|number[]|PrefixedHexString}
 */
const stripZeros = (a) => {
    let first = a[0];
    while (a.length > 0 && first.toString() === '0') {
        a = a.slice(1);
        first = a[0];
    }
    return a;
};
/**
 * Trims leading zeros from a `Uint8Array`.
 * @param {Uint8Array} a
 * @return {Uint8Array}
 */
const unpadBytes = (a) => {
    assertIsBytes(a);
    return stripZeros(a);
};
/**
 * Attempts to turn a value into a `Uint8Array`.
 * Inputs supported: `Buffer`, `Uint8Array`, `String` (hex-prefixed), `Number`, null/undefined, `BigInt` and other objects
 * with a `toArray()` or `toBytes()` method.
 * @param {ToBytesInputTypes} v the value
 * @return {Uint8Array}
 */
const toBytes = (v) => {
    if (v === null || v === undefined) {
        return new Uint8Array();
    }
    if (Array.isArray(v) || v instanceof Uint8Array) {
        return Uint8Array.from(v);
    }
    if (typeof v === 'string') {
        if (!isHexString(v)) {
            throw new Error(`Cannot convert string to Uint8Array. toBytes only supports 0x-prefixed hex strings and this string was given: ${v}`);
        }
        return hexToBytes(v);
    }
    if (typeof v === 'number') {
        return intToBytes(v);
    }
    if (typeof v === 'bigint') {
        if (v < BIGINT_0$1) {
            throw new Error(`Cannot convert negative bigint to Uint8Array. Given: ${v}`);
        }
        let n = v.toString(16);
        if (n.length % 2)
            n = '0' + n;
        return unprefixedHexToBytes(n);
    }
    if (v.toBytes !== undefined) {
        // converts a `TransformableToBytes` object to a Uint8Array
        return v.toBytes();
    }
    throw new Error('invalid type');
};
/**
 * Checks provided Uint8Array for leading zeroes and throws if found.
 *
 * Examples:
 *
 * Valid values: 0x1, 0x, 0x01, 0x1234
 * Invalid values: 0x0, 0x00, 0x001, 0x0001
 *
 * Note: This method is useful for validating that RLP encoded integers comply with the rule that all
 * integer values encoded to RLP must be in the most compact form and contain no leading zero bytes
 * @param values An object containing string keys and Uint8Array values
 * @throws if any provided value is found to have leading zero bytes
 */
const validateNoLeadingZeroes = (values) => {
    for (const [k, v] of Object.entries(values)) {
        if (v !== undefined && v.length > 0 && v[0] === 0) {
            throw new Error(`${k} cannot have leading zeroes, received: ${bytesToHex(v)}`);
        }
    }
};
/**
 * Converts a {@link bigint} to a `0x` prefixed hex string
 * @param {bigint} num the bigint to convert
 * @returns {PrefixedHexString}
 */
const bigIntToHex = (num) => {
    return '0x' + num.toString(16);
};
/**
 * Convert value from bigint to an unpadded Uint8Array
 * (useful for RLP transport)
 * @param {bigint} value the bigint to convert
 * @returns {Uint8Array}
 */
const bigIntToUnpaddedBytes = (value) => {
    return unpadBytes(bigIntToBytes(value));
};
/**
 * This mirrors the functionality of the `ethereum-cryptography` export except
 * it skips the check to validate that every element of `arrays` is indead a `uint8Array`
 * Can give small performance gains on large arrays
 * @param {Uint8Array[]} arrays an array of Uint8Arrays
 * @returns {Uint8Array} one Uint8Array with all the elements of the original set
 * works like `Buffer.concat`
 */
const concatBytes = (...arrays) => {
    if (arrays.length === 1)
        return arrays[0];
    const length = arrays.reduce((a, arr) => a + arr.length, 0);
    const result = new Uint8Array(length);
    for (let i = 0, pad = 0; i < arrays.length; i++) {
        const arr = arrays[i];
        result.set(arr, pad);
        pad += arr.length;
    }
    return result;
};

/**
 * 2^64-1
 */
const MAX_UINT64 = BigInt('0xffffffffffffffff');
/**
 * The max integer that the evm can handle (2^256-1)
 */
const MAX_INTEGER = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
/**
 * The max integer that the evm can handle (2^256-1) as a bigint
 * 2^256-1 equals to 340282366920938463463374607431768211455
 * We use literal value instead of calculated value for compatibility issue.
 */
BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935');
secp256k1.CURVE.n;
const SECP256K1_ORDER_DIV_2 = secp256k1.CURVE.n / BigInt(2);
/**
 * 2^256
 */
BigInt('0x10000000000000000000000000000000000000000000000000000000000000000');
/**
 * Keccak-256 hash of null
 */
const KECCAK256_NULL_S = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
/**
 * Keccak-256 hash of null
 */
hexToBytes(KECCAK256_NULL_S);
/**
 * Keccak-256 of an RLP of an empty array
 */
const KECCAK256_RLP_ARRAY_S = '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347';
/**
 * Keccak-256 of an RLP of an empty array
 */
hexToBytes(KECCAK256_RLP_ARRAY_S);
/**
 * Keccak-256 hash of the RLP of null
 */
const KECCAK256_RLP_S = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
/**
 * Keccak-256 hash of the RLP of null
 */
hexToBytes(KECCAK256_RLP_S);
/**
 *  RLP encoded empty string
 */
Uint8Array.from([0x80]);
/**
 * BigInt constants
 */
BigInt(-1);
const BIGINT_0 = BigInt(0);
const BIGINT_1 = BigInt(1);
const BIGINT_2 = BigInt(2);
BigInt(3);
BigInt(7);
BigInt(8);
const BIGINT_27 = BigInt(27);
BigInt(28);
BigInt(31);
BigInt(32);
BigInt(64);
BigInt(128);
BigInt(255);
BigInt(256);
BigInt(96);
BigInt(100);
BigInt(160);
BigInt(224);
BigInt(79228162514264337593543950336);
BigInt(1461501637330902918203684832716283019655932542976);
BigInt(26959946667150639794667015087019630673637144422540572481103610249216);

/** Easy conversion from Gwei to wei */
BigInt(1000000000);

const U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
const _32n = /* @__PURE__ */ BigInt(32);
// We are not using BigUint64Array, because they are extremely slow as per 2022
function fromBig(n, le = false) {
    if (le)
        return { h: Number(n & U32_MASK64), l: Number((n >> _32n) & U32_MASK64) };
    return { h: Number((n >> _32n) & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
    let Ah = new Uint32Array(lst.length);
    let Al = new Uint32Array(lst.length);
    for (let i = 0; i < lst.length; i++) {
        const { h, l } = fromBig(lst[i], le);
        [Ah[i], Al[i]] = [h, l];
    }
    return [Ah, Al];
}
// Left rotate for Shift in [1, 32)
const rotlSH = (h, l, s) => (h << s) | (l >>> (32 - s));
const rotlSL = (h, l, s) => (l << s) | (h >>> (32 - s));
// Left rotate for Shift in (32, 64), NOTE: 32 is special case.
const rotlBH = (h, l, s) => (l << (s - 32)) | (h >>> (64 - s));
const rotlBL = (h, l, s) => (h << (s - 32)) | (l >>> (64 - s));

// SHA3 (keccak) is based on a new design: basically, the internal state is bigger than output size.
// It's called a sponge function.
// Various per round constants calculations
const [SHA3_PI, SHA3_ROTL, _SHA3_IOTA] = [[], [], []];
const _0n = /* @__PURE__ */ BigInt(0);
const _1n = /* @__PURE__ */ BigInt(1);
const _2n = /* @__PURE__ */ BigInt(2);
const _7n = /* @__PURE__ */ BigInt(7);
const _256n = /* @__PURE__ */ BigInt(256);
const _0x71n = /* @__PURE__ */ BigInt(0x71);
for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
    // Pi
    [x, y] = [y, (2 * x + 3 * y) % 5];
    SHA3_PI.push(2 * (5 * y + x));
    // Rotational
    SHA3_ROTL.push((((round + 1) * (round + 2)) / 2) % 64);
    // Iota
    let t = _0n;
    for (let j = 0; j < 7; j++) {
        R = ((R << _1n) ^ ((R >> _7n) * _0x71n)) % _256n;
        if (R & _2n)
            t ^= _1n << ((_1n << /* @__PURE__ */ BigInt(j)) - _1n);
    }
    _SHA3_IOTA.push(t);
}
const [SHA3_IOTA_H, SHA3_IOTA_L] = /* @__PURE__ */ split(_SHA3_IOTA, true);
// Left rotation (without 0, 32, 64)
const rotlH = (h, l, s) => (s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s));
const rotlL = (h, l, s) => (s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s));
// Same as keccakf1600, but allows to skip some rounds
function keccakP(s, rounds = 24) {
    const B = new Uint32Array(5 * 2);
    // NOTE: all indices are x2 since we store state as u32 instead of u64 (bigints to slow in js)
    for (let round = 24 - rounds; round < 24; round++) {
        // Theta θ
        for (let x = 0; x < 10; x++)
            B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
        for (let x = 0; x < 10; x += 2) {
            const idx1 = (x + 8) % 10;
            const idx0 = (x + 2) % 10;
            const B0 = B[idx0];
            const B1 = B[idx0 + 1];
            const Th = rotlH(B0, B1, 1) ^ B[idx1];
            const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
            for (let y = 0; y < 50; y += 10) {
                s[x + y] ^= Th;
                s[x + y + 1] ^= Tl;
            }
        }
        // Rho (ρ) and Pi (π)
        let curH = s[2];
        let curL = s[3];
        for (let t = 0; t < 24; t++) {
            const shift = SHA3_ROTL[t];
            const Th = rotlH(curH, curL, shift);
            const Tl = rotlL(curH, curL, shift);
            const PI = SHA3_PI[t];
            curH = s[PI];
            curL = s[PI + 1];
            s[PI] = Th;
            s[PI + 1] = Tl;
        }
        // Chi (χ)
        for (let y = 0; y < 50; y += 10) {
            for (let x = 0; x < 10; x++)
                B[x] = s[y + x];
            for (let x = 0; x < 10; x++)
                s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
        }
        // Iota (ι)
        s[0] ^= SHA3_IOTA_H[round];
        s[1] ^= SHA3_IOTA_L[round];
    }
    B.fill(0);
}
class Keccak extends Hash {
    // NOTE: we accept arguments in bytes instead of bits here.
    constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
        super();
        this.blockLen = blockLen;
        this.suffix = suffix;
        this.outputLen = outputLen;
        this.enableXOF = enableXOF;
        this.rounds = rounds;
        this.pos = 0;
        this.posOut = 0;
        this.finished = false;
        this.destroyed = false;
        // Can be passed from user as dkLen
        number(outputLen);
        // 1600 = 5x5 matrix of 64bit.  1600 bits === 200 bytes
        if (0 >= this.blockLen || this.blockLen >= 200)
            throw new Error('Sha3 supports only keccak-f1600 function');
        this.state = new Uint8Array(200);
        this.state32 = u32(this.state);
    }
    keccak() {
        keccakP(this.state32, this.rounds);
        this.posOut = 0;
        this.pos = 0;
    }
    update(data) {
        exists(this);
        const { blockLen, state } = this;
        data = toBytes$1(data);
        const len = data.length;
        for (let pos = 0; pos < len;) {
            const take = Math.min(blockLen - this.pos, len - pos);
            for (let i = 0; i < take; i++)
                state[this.pos++] ^= data[pos++];
            if (this.pos === blockLen)
                this.keccak();
        }
        return this;
    }
    finish() {
        if (this.finished)
            return;
        this.finished = true;
        const { state, suffix, pos, blockLen } = this;
        // Do the padding
        state[pos] ^= suffix;
        if ((suffix & 0x80) !== 0 && pos === blockLen - 1)
            this.keccak();
        state[blockLen - 1] ^= 0x80;
        this.keccak();
    }
    writeInto(out) {
        exists(this, false);
        bytes(out);
        this.finish();
        const bufferOut = this.state;
        const { blockLen } = this;
        for (let pos = 0, len = out.length; pos < len;) {
            if (this.posOut >= blockLen)
                this.keccak();
            const take = Math.min(blockLen - this.posOut, len - pos);
            out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
            this.posOut += take;
            pos += take;
        }
        return out;
    }
    xofInto(out) {
        // Sha3/Keccak usage with XOF is probably mistake, only SHAKE instances can do XOF
        if (!this.enableXOF)
            throw new Error('XOF is not possible for this instance');
        return this.writeInto(out);
    }
    xof(bytes) {
        number(bytes);
        return this.xofInto(new Uint8Array(bytes));
    }
    digestInto(out) {
        output(out, this);
        if (this.finished)
            throw new Error('digest() was already called');
        this.writeInto(out);
        this.destroy();
        return out;
    }
    digest() {
        return this.digestInto(new Uint8Array(this.outputLen));
    }
    destroy() {
        this.destroyed = true;
        this.state.fill(0);
    }
    _cloneInto(to) {
        const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
        to || (to = new Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
        to.state32.set(this.state32);
        to.pos = this.pos;
        to.posOut = this.posOut;
        to.finished = this.finished;
        to.rounds = rounds;
        // Suffix can change in cSHAKE
        to.suffix = suffix;
        to.outputLen = outputLen;
        to.enableXOF = enableXOF;
        to.destroyed = this.destroyed;
        return to;
    }
}
const gen = (suffix, blockLen, outputLen) => wrapConstructor(() => new Keccak(blockLen, suffix, outputLen));
/**
 * keccak-256 hash function. Different from SHA3-256.
 * @param message - that would be hashed
 */
const keccak_256 = /* @__PURE__ */ gen(0x01, 136, 256 / 8);

const keccak256 = (() => {
    const k = wrapHash(keccak_256);
    k.create = keccak_256.create;
    return k;
})();

/**
 * Checks if the address is a valid. Accepts checksummed addresses too.
 */
const isValidAddress = function (hexAddress) {
    try {
        assertIsString(hexAddress);
    }
    catch (e) {
        return false;
    }
    return /^0x[0-9a-fA-F]{40}$/.test(hexAddress);
};
/**
 * Generates an address of a newly created contract.
 * @param from The address which is creating this new address
 * @param nonce The nonce of the from account
 */
const generateAddress = function (from, nonce) {
    assertIsBytes(from);
    assertIsBytes(nonce);
    if (bytesToBigInt(nonce) === BIGINT_0) {
        // in RLP we want to encode null in the case of zero nonce
        // read the RLP documentation for an answer if you dare
        return keccak256(RLP.encode([from, Uint8Array.from([])])).subarray(-20);
    }
    // Only take the lower 160bits of the hash
    return keccak256(RLP.encode([from, nonce])).subarray(-20);
};
/**
 * Generates an address for a contract created using CREATE2.
 * @param from The address which is creating this new address
 * @param salt A salt
 * @param initCode The init code of the contract being created
 */
const generateAddress2 = function (from, salt, initCode) {
    assertIsBytes(from);
    assertIsBytes(salt);
    assertIsBytes(initCode);
    if (from.length !== 20) {
        throw new Error('Expected from to be of length 20');
    }
    if (salt.length !== 32) {
        throw new Error('Expected salt to be of length 32');
    }
    const address = keccak256(concatBytes(hexToBytes('0xff'), from, salt, keccak256(initCode)));
    return address.subarray(-20);
};
/**
 * Returns the ethereum address of a given public key.
 * Accepts "Ethereum public keys" and SEC1 encoded keys.
 * @param pubKey The two points of an uncompressed key, unless sanitize is enabled
 * @param sanitize Accept public keys in other formats
 */
const pubToAddress = function (pubKey, sanitize = false) {
    assertIsBytes(pubKey);
    if (sanitize && pubKey.length !== 64) {
        pubKey = secp256k1.ProjectivePoint.fromHex(pubKey).toRawBytes(false).slice(1);
    }
    if (pubKey.length !== 64) {
        throw new Error('Expected pubKey to be of length 64');
    }
    // Only take the lower 160bits of the hash
    return keccak256(pubKey).subarray(-20);
};
const publicToAddress = pubToAddress;
/**
 * Returns the ethereum public key of a given private key.
 * @param privateKey A private key must be 256 bits wide
 */
const privateToPublic = function (privateKey) {
    assertIsBytes(privateKey);
    // skip the type flag and use the X, Y points
    return secp256k1.ProjectivePoint.fromPrivateKey(privateKey).toRawBytes(false).slice(1);
};
/**
 * Returns the ethereum address of a given private key.
 * @param privateKey A private key must be 256 bits wide
 */
const privateToAddress = function (privateKey) {
    return publicToAddress(privateToPublic(privateKey));
};

/**
 * Handling and generating Ethereum addresses
 */
class Address {
    constructor(bytes) {
        if (bytes.length !== 20) {
            throw new Error('Invalid address length');
        }
        this.bytes = bytes;
    }
    /**
     * Returns the zero address.
     */
    static zero() {
        return new Address(zeros(20));
    }
    /**
     * Returns an Address object from a hex-encoded string.
     * @param str - Hex-encoded address
     */
    static fromString(str) {
        if (!isValidAddress(str)) {
            throw new Error('Invalid address');
        }
        return new Address(toBytes(str));
    }
    /**
     * Returns an address for a given public key.
     * @param pubKey The two points of an uncompressed key
     */
    static fromPublicKey(pubKey) {
        if (!(pubKey instanceof Uint8Array)) {
            throw new Error('Public key should be Uint8Array');
        }
        const bytes = pubToAddress(pubKey);
        return new Address(bytes);
    }
    /**
     * Returns an address for a given private key.
     * @param privateKey A private key must be 256 bits wide
     */
    static fromPrivateKey(privateKey) {
        if (!(privateKey instanceof Uint8Array)) {
            throw new Error('Private key should be Uint8Array');
        }
        const bytes = privateToAddress(privateKey);
        return new Address(bytes);
    }
    /**
     * Generates an address for a newly created contract.
     * @param from The address which is creating this new address
     * @param nonce The nonce of the from account
     */
    static generate(from, nonce) {
        if (typeof nonce !== 'bigint') {
            throw new Error('Expected nonce to be a bigint');
        }
        return new Address(generateAddress(from.bytes, bigIntToBytes(nonce)));
    }
    /**
     * Generates an address for a contract created using CREATE2.
     * @param from The address which is creating this new address
     * @param salt A salt
     * @param initCode The init code of the contract being created
     */
    static generate2(from, salt, initCode) {
        if (!(salt instanceof Uint8Array)) {
            throw new Error('Expected salt to be a Uint8Array');
        }
        if (!(initCode instanceof Uint8Array)) {
            throw new Error('Expected initCode to be a Uint8Array');
        }
        return new Address(generateAddress2(from.bytes, salt, initCode));
    }
    /**
     * Is address equal to another.
     */
    equals(address) {
        return equalsBytes(this.bytes, address.bytes);
    }
    /**
     * Is address zero.
     */
    isZero() {
        return this.equals(Address.zero());
    }
    /**
     * True if address is in the address range defined
     * by EIP-1352
     */
    isPrecompileOrSystemAddress() {
        const address = bytesToBigInt(this.bytes);
        const rangeMin = BIGINT_0;
        const rangeMax = BigInt('0xffff');
        return address >= rangeMin && address <= rangeMax;
    }
    /**
     * Returns hex encoding of address.
     */
    toString() {
        return bytesToHex(this.bytes);
    }
    /**
     * Returns a new Uint8Array representation of address.
     */
    toBytes() {
        return new Uint8Array(this.bytes);
    }
}

var KeyEncoding;
(function (KeyEncoding) {
    KeyEncoding["String"] = "string";
    KeyEncoding["Bytes"] = "view";
    KeyEncoding["Number"] = "number";
})(KeyEncoding || (KeyEncoding = {}));
var ValueEncoding;
(function (ValueEncoding) {
    ValueEncoding["String"] = "string";
    ValueEncoding["Bytes"] = "view";
    ValueEncoding["JSON"] = "json";
})(ValueEncoding || (ValueEncoding = {}));

/**
 * Type output options
 */
var TypeOutput;
(function (TypeOutput) {
    TypeOutput[TypeOutput["Number"] = 0] = "Number";
    TypeOutput[TypeOutput["BigInt"] = 1] = "BigInt";
    TypeOutput[TypeOutput["Uint8Array"] = 2] = "Uint8Array";
    TypeOutput[TypeOutput["PrefixedHexString"] = 3] = "PrefixedHexString";
})(TypeOutput || (TypeOutput = {}));
function toType(input, outputType) {
    if (input === null) {
        return null;
    }
    if (input === undefined) {
        return undefined;
    }
    if (typeof input === 'string' && !isHexString(input)) {
        throw new Error(`A string must be provided with a 0x-prefix, given: ${input}`);
    }
    else if (typeof input === 'number' && !Number.isSafeInteger(input)) {
        throw new Error('The provided number is greater than MAX_SAFE_INTEGER (please use an alternative input type)');
    }
    const output = toBytes(input);
    switch (outputType) {
        case TypeOutput.Uint8Array:
            return output;
        case TypeOutput.BigInt:
            return bytesToBigInt(output);
        case TypeOutput.Number: {
            const bigInt = bytesToBigInt(output);
            if (bigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error('The provided number is greater than MAX_SAFE_INTEGER (please use an alternative output type)');
            }
            return Number(bigInt);
        }
        case TypeOutput.PrefixedHexString:
            return bytesToHex(output);
        default:
            throw new Error('unknown outputType');
    }
}

/**
 * Returns the ECDSA signature of a message hash.
 *
 * If `chainId` is provided assume an EIP-155-style signature and calculate the `v` value
 * accordingly, otherwise return a "static" `v` just derived from the `recovery` bit
 */
function ecsign(msgHash, privateKey, chainId) {
    const sig = secp256k1.sign(msgHash, privateKey);
    const buf = sig.toCompactRawBytes();
    const r = buf.slice(0, 32);
    const s = buf.slice(32, 64);
    const v = chainId === undefined
        ? BigInt(sig.recovery + 27)
        : BigInt(sig.recovery + 35) + BigInt(chainId) * BIGINT_2;
    return { r, s, v };
}
function calculateSigRecovery(v, chainId) {
    if (v === BIGINT_0 || v === BIGINT_1)
        return v;
    if (chainId === undefined) {
        return v - BIGINT_27;
    }
    return v - (chainId * BIGINT_2 + BigInt(35));
}
function isValidSigRecovery(recovery) {
    return recovery === BIGINT_0 || recovery === BIGINT_1;
}
/**
 * ECDSA public key recovery from signature.
 * NOTE: Accepts `v === 0 | v === 1` for EIP1559 transactions
 * @returns Recovered public key
 */
const ecrecover = function (msgHash, v, r, s, chainId) {
    const signature = concatBytes(setLengthLeft(r, 32), setLengthLeft(s, 32));
    const recovery = calculateSigRecovery(v, chainId);
    if (!isValidSigRecovery(recovery)) {
        throw new Error('Invalid signature v value');
    }
    const sig = secp256k1.Signature.fromCompact(signature).addRecoveryBit(Number(recovery));
    const senderPubKey = sig.recoverPublicKey(msgHash);
    return senderPubKey.toRawBytes(false).slice(1);
};

const sha256 = wrapHash(sha256$1);

function kzgNotLoaded() {
    throw Error('kzg library not loaded');
}
// eslint-disable-next-line import/no-mutable-exports
let kzg = {
    loadTrustedSetup: kzgNotLoaded,
    blobToKzgCommitment: kzgNotLoaded,
    computeBlobKzgProof: kzgNotLoaded,
    verifyKzgProof: kzgNotLoaded,
    verifyBlobKzgProofBatch: kzgNotLoaded,
};

/**
 * These utilities for constructing blobs are borrowed from https://github.com/Inphi/eip4844-interop.git
 */
const BYTES_PER_FIELD_ELEMENT = 32;
const FIELD_ELEMENTS_PER_BLOB = 4096;
const USEFUL_BYTES_PER_BLOB = 32 * FIELD_ELEMENTS_PER_BLOB;
const MAX_BLOBS_PER_TX = 2;
const MAX_USEFUL_BYTES_PER_TX = USEFUL_BYTES_PER_BLOB * MAX_BLOBS_PER_TX - 1;
const BLOB_SIZE$1 = BYTES_PER_FIELD_ELEMENT * FIELD_ELEMENTS_PER_BLOB;
function get_padded(data, blobs_len) {
    const pdata = new Uint8Array(blobs_len * USEFUL_BYTES_PER_BLOB).fill(0);
    pdata.set(data);
    pdata[data.byteLength] = 0x80;
    return pdata;
}
function get_blob(data) {
    const blob = new Uint8Array(BLOB_SIZE$1);
    for (let i = 0; i < FIELD_ELEMENTS_PER_BLOB; i++) {
        const chunk = new Uint8Array(32);
        chunk.set(data.subarray(i * 31, (i + 1) * 31), 0);
        blob.set(chunk, i * 32);
    }
    return blob;
}
const getBlobs = (input) => {
    const data = utf8ToBytes$1(input);
    const len = data.byteLength;
    if (len === 0) {
        throw Error('invalid blob data');
    }
    if (len > MAX_USEFUL_BYTES_PER_TX) {
        throw Error('blob data is too large');
    }
    const blobs_len = Math.ceil(len / USEFUL_BYTES_PER_BLOB);
    const pdata = get_padded(data, blobs_len);
    const blobs = [];
    for (let i = 0; i < blobs_len; i++) {
        const chunk = pdata.subarray(i * USEFUL_BYTES_PER_BLOB, (i + 1) * USEFUL_BYTES_PER_BLOB);
        const blob = get_blob(chunk);
        blobs.push(blob);
    }
    return blobs;
};
const blobsToCommitments = (blobs) => {
    const commitments = [];
    for (const blob of blobs) {
        commitments.push(kzg.blobToKzgCommitment(blob));
    }
    return commitments;
};
const blobsToProofs = (blobs, commitments) => {
    const proofs = blobs.map((blob, ctx) => kzg.computeBlobKzgProof(blob, commitments[ctx]));
    return proofs;
};
/**
 * Converts a vector commitment for a given data blob to its versioned hash.  For 4844, this version
 * number will be 0x01 for KZG vector commitments but could be different if future vector commitment
 * types are introduced
 * @param commitment a vector commitment to a blob
 * @param blobCommitmentVersion the version number corresponding to the type of vector commitment
 * @returns a versioned hash corresponding to a given blob vector commitment
 */
const computeVersionedHash$1 = (commitment, blobCommitmentVersion) => {
    const computedVersionedHash = new Uint8Array(32);
    computedVersionedHash.set([blobCommitmentVersion], 0);
    computedVersionedHash.set(sha256(commitment).subarray(1), 1);
    return computedVersionedHash;
};
/**
 * Generate an array of versioned hashes from corresponding kzg commitments
 * @param commitments array of kzg commitments
 * @returns array of versioned hashes
 * Note: assumes KZG commitments (version 1 version hashes)
 */
const commitmentsToVersionedHashes$1 = (commitments) => {
    const hashes = [];
    for (const commitment of commitments) {
        hashes.push(computeVersionedHash$1(commitment, 0x01));
    }
    return hashes;
};

const chains = {
    mainnet: {
        name: 'mainnet',
        chainId: 1,
        networkId: 1,
        defaultHardfork: 'shanghai',
        consensus: {
            type: 'pow',
            algorithm: 'ethash',
            ethash: {},
        },
        comment: 'The Ethereum main chain',
        url: 'https://ethstats.net/',
        genesis: {
            gasLimit: 5000,
            difficulty: 17179869184,
            nonce: '0x0000000000000042',
            extraData: '0x11bbe8db4e347b4e8c937c1c8370e4b5ed33adb3db69cbdb7a38e1e50b1b82fa',
        },
        hardforks: [
            {
                name: 'chainstart',
                block: 0,
                forkHash: '0xfc64ec04',
            },
            {
                name: 'homestead',
                block: 1150000,
                forkHash: '0x97c2c34c',
            },
            {
                name: 'dao',
                block: 1920000,
                forkHash: '0x91d1f948',
            },
            {
                name: 'tangerineWhistle',
                block: 2463000,
                forkHash: '0x7a64da13',
            },
            {
                name: 'spuriousDragon',
                block: 2675000,
                forkHash: '0x3edd5b10',
            },
            {
                name: 'byzantium',
                block: 4370000,
                forkHash: '0xa00bc324',
            },
            {
                name: 'constantinople',
                block: 7280000,
                forkHash: '0x668db0af',
            },
            {
                name: 'petersburg',
                block: 7280000,
                forkHash: '0x668db0af',
            },
            {
                name: 'istanbul',
                block: 9069000,
                forkHash: '0x879d6e30',
            },
            {
                name: 'muirGlacier',
                block: 9200000,
                forkHash: '0xe029e991',
            },
            {
                name: 'berlin',
                block: 12244000,
                forkHash: '0x0eb440f6',
            },
            {
                name: 'london',
                block: 12965000,
                forkHash: '0xb715077d',
            },
            {
                name: 'arrowGlacier',
                block: 13773000,
                forkHash: '0x20c327fc',
            },
            {
                name: 'grayGlacier',
                block: 15050000,
                forkHash: '0xf0afd0e3',
            },
            {
                // The forkHash will remain same as mergeForkIdTransition is post merge
                // terminal block: https://etherscan.io/block/15537393
                name: 'paris',
                ttd: '58750000000000000000000',
                block: 15537394,
                forkHash: '0xf0afd0e3',
            },
            {
                name: 'mergeForkIdTransition',
                block: null,
                forkHash: null,
            },
            {
                name: 'shanghai',
                block: null,
                timestamp: '1681338455',
                forkHash: '0xdce96c2d',
            },
            {
                name: 'cancun',
                block: null,
                timestamp: '1710338135',
                forkHash: '0x9f3d2254',
            },
        ],
        bootstrapNodes: [
            {
                ip: '18.138.108.67',
                port: 30303,
                id: 'd860a01f9722d78051619d1e2351aba3f43f943f6f00718d1b9baa4101932a1f5011f16bb2b1bb35db20d6fe28fa0bf09636d26a87d31de9ec6203eeedb1f666',
                location: 'ap-southeast-1-001',
                comment: 'bootnode-aws-ap-southeast-1-001',
            },
            {
                ip: '3.209.45.79',
                port: 30303,
                id: '22a8232c3abc76a16ae9d6c3b164f98775fe226f0917b0ca871128a74a8e9630b458460865bab457221f1d448dd9791d24c4e5d88786180ac185df813a68d4de',
                location: 'us-east-1-001',
                comment: 'bootnode-aws-us-east-1-001',
            },
            {
                ip: '65.108.70.101',
                port: 30303,
                id: '2b252ab6a1d0f971d9722cb839a42cb81db019ba44c08754628ab4a823487071b5695317c8ccd085219c3a03af063495b2f1da8d18218da2d6a82981b45e6ffc',
                location: 'eu-west-1-001',
                comment: 'bootnode-hetzner-hel',
            },
            {
                ip: '157.90.35.166',
                port: 30303,
                id: '4aeb4ab6c14b23e2c4cfdce879c04b0748a20d8e9b59e25ded2a08143e265c6c25936e74cbc8e641e3312ca288673d91f2f93f8e277de3cfa444ecdaaf982052',
                location: 'eu-central-1-001',
                comment: 'bootnode-hetzner-fsn',
            },
        ],
        dnsNetworks: [
            'enrtree://AKA3AM6LPBYEUDMVNU3BSVQJ5AD45Y7YPOHJLEF6W26QOE4VTUDPE@all.mainnet.ethdisco.net',
        ],
    },
    goerli: {
        name: 'goerli',
        chainId: 5,
        networkId: 5,
        defaultHardfork: 'shanghai',
        consensus: {
            type: 'poa',
            algorithm: 'clique',
            clique: {
                period: 15,
                epoch: 30000,
            },
        },
        comment: 'Cross-client PoA test network',
        url: 'https://github.com/goerli/testnet',
        genesis: {
            timestamp: '0x5c51a607',
            gasLimit: 10485760,
            difficulty: 1,
            nonce: '0x0000000000000000',
            extraData: '0x22466c6578692069732061207468696e6722202d204166726900000000000000e0a2bd4258d2768837baa26a28fe71dc079f84c70000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
        },
        hardforks: [
            {
                name: 'chainstart',
                block: 0,
                forkHash: '0xa3f5ab08',
            },
            {
                name: 'homestead',
                block: 0,
                forkHash: '0xa3f5ab08',
            },
            {
                name: 'tangerineWhistle',
                block: 0,
                forkHash: '0xa3f5ab08',
            },
            {
                name: 'spuriousDragon',
                block: 0,
                forkHash: '0xa3f5ab08',
            },
            {
                name: 'byzantium',
                block: 0,
                forkHash: '0xa3f5ab08',
            },
            {
                name: 'constantinople',
                block: 0,
                forkHash: '0xa3f5ab08',
            },
            {
                name: 'petersburg',
                block: 0,
                forkHash: '0xa3f5ab08',
            },
            {
                name: 'istanbul',
                block: 1561651,
                forkHash: '0xc25efa5c',
            },
            {
                name: 'berlin',
                block: 4460644,
                forkHash: '0x757a1c47',
            },
            {
                name: 'london',
                block: 5062605,
                forkHash: '0xb8c6299d',
            },
            {
                // The forkHash will remain same as mergeForkIdTransition is post merge,
                // terminal block: https://goerli.etherscan.io/block/7382818
                name: 'paris',
                ttd: '10790000',
                block: 7382819,
                forkHash: '0xb8c6299d',
            },
            {
                name: 'mergeForkIdTransition',
                block: null,
                forkHash: null,
            },
            {
                name: 'shanghai',
                block: null,
                timestamp: '1678832736',
                forkHash: '0xf9843abf',
            },
            {
                name: 'cancun',
                block: null,
                timestamp: '1705473120',
                forkHash: '0x70cc14e2',
            },
        ],
        bootstrapNodes: [
            {
                ip: '51.141.78.53',
                port: 30303,
                id: '011f758e6552d105183b1761c5e2dea0111bc20fd5f6422bc7f91e0fabbec9a6595caf6239b37feb773dddd3f87240d99d859431891e4a642cf2a0a9e6cbb98a',
                location: '',
                comment: 'Upstream bootnode 1',
            },
            {
                ip: '13.93.54.137',
                port: 30303,
                id: '176b9417f511d05b6b2cf3e34b756cf0a7096b3094572a8f6ef4cdcb9d1f9d00683bf0f83347eebdf3b81c3521c2332086d9592802230bf528eaf606a1d9677b',
                location: '',
                comment: 'Upstream bootnode 2',
            },
            {
                ip: '94.237.54.114',
                port: 30313,
                id: '46add44b9f13965f7b9875ac6b85f016f341012d84f975377573800a863526f4da19ae2c620ec73d11591fa9510e992ecc03ad0751f53cc02f7c7ed6d55c7291',
                location: '',
                comment: 'Upstream bootnode 3',
            },
            {
                ip: '18.218.250.66',
                port: 30313,
                id: 'b5948a2d3e9d486c4d75bf32713221c2bd6cf86463302339299bd227dc2e276cd5a1c7ca4f43a0e9122fe9af884efed563bd2a1fd28661f3b5f5ad7bf1de5949',
                location: '',
                comment: 'Upstream bootnode 4',
            },
            {
                ip: '3.11.147.67',
                port: 30303,
                id: 'a61215641fb8714a373c80edbfa0ea8878243193f57c96eeb44d0bc019ef295abd4e044fd619bfc4c59731a73fb79afe84e9ab6da0c743ceb479cbb6d263fa91',
                location: '',
                comment: 'Ethereum Foundation bootnode',
            },
            {
                ip: '51.15.116.226',
                port: 30303,
                id: 'a869b02cec167211fb4815a82941db2e7ed2936fd90e78619c53eb17753fcf0207463e3419c264e2a1dd8786de0df7e68cf99571ab8aeb7c4e51367ef186b1dd',
                location: '',
                comment: 'Goerli Initiative bootnode',
            },
            {
                ip: '51.15.119.157',
                port: 30303,
                id: '807b37ee4816ecf407e9112224494b74dd5933625f655962d892f2f0f02d7fbbb3e2a94cf87a96609526f30c998fd71e93e2f53015c558ffc8b03eceaf30ee33',
                location: '',
                comment: 'Goerli Initiative bootnode',
            },
            {
                ip: '51.15.119.157',
                port: 40303,
                id: 'a59e33ccd2b3e52d578f1fbd70c6f9babda2650f0760d6ff3b37742fdcdfdb3defba5d56d315b40c46b70198c7621e63ffa3f987389c7118634b0fefbbdfa7fd',
                location: '',
                comment: 'Goerli Initiative bootnode',
            },
        ],
        dnsNetworks: [
            'enrtree://AKA3AM6LPBYEUDMVNU3BSVQJ5AD45Y7YPOHJLEF6W26QOE4VTUDPE@all.goerli.ethdisco.net',
        ],
    },
    sepolia: {
        name: 'sepolia',
        chainId: 11155111,
        networkId: 11155111,
        defaultHardfork: 'shanghai',
        consensus: {
            type: 'pow',
            algorithm: 'ethash',
            ethash: {},
        },
        comment: 'PoW test network to replace Ropsten',
        url: 'https://github.com/ethereum/go-ethereum/pull/23730',
        genesis: {
            timestamp: '0x6159af19',
            gasLimit: 30000000,
            difficulty: 131072,
            nonce: '0x0000000000000000',
            extraData: '0x5365706f6c69612c20417468656e732c204174746963612c2047726565636521',
        },
        hardforks: [
            {
                name: 'chainstart',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'homestead',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'tangerineWhistle',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'spuriousDragon',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'byzantium',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'constantinople',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'petersburg',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'istanbul',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'muirGlacier',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'berlin',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'london',
                block: 0,
                forkHash: '0xfe3366e7',
            },
            {
                // The forkHash will remain same as mergeForkIdTransition is post merge,
                // terminal block: https://sepolia.etherscan.io/block/1450408
                name: 'paris',
                ttd: '17000000000000000',
                block: 1450409,
                forkHash: '0xfe3366e7',
            },
            {
                name: 'mergeForkIdTransition',
                block: 1735371,
                forkHash: '0xb96cbd13',
            },
            {
                name: 'shanghai',
                block: null,
                timestamp: '1677557088',
                forkHash: '0xf7f9bc08',
            },
            {
                name: 'cancun',
                block: null,
                timestamp: '1706655072',
                forkHash: '0x88cf81d9',
            },
        ],
        bootstrapNodes: [
            {
                ip: '18.168.182.86',
                port: 30303,
                id: '9246d00bc8fd1742e5ad2428b80fc4dc45d786283e05ef6edbd9002cbc335d40998444732fbe921cb88e1d2c73d1b1de53bae6a2237996e9bfe14f871baf7066',
                location: '',
                comment: 'geth',
            },
            {
                ip: '52.14.151.177',
                port: 30303,
                id: 'ec66ddcf1a974950bd4c782789a7e04f8aa7110a72569b6e65fcd51e937e74eed303b1ea734e4d19cfaec9fbff9b6ee65bf31dcb50ba79acce9dd63a6aca61c7',
                location: '',
                comment: 'besu',
            },
            {
                ip: '165.22.196.173',
                port: 30303,
                id: 'ce970ad2e9daa9e14593de84a8b49da3d54ccfdf83cbc4fe519cb8b36b5918ed4eab087dedd4a62479b8d50756b492d5f762367c8d20329a7854ec01547568a6',
                location: '',
                comment: 'EF',
            },
            {
                ip: '65.108.95.67',
                port: 30303,
                id: '075503b13ed736244896efcde2a992ec0b451357d46cb7a8132c0384721742597fc8f0d91bbb40bb52e7d6e66728d36a1fda09176294e4a30cfac55dcce26bc6',
                location: '',
                comment: 'lodestar',
            },
        ],
        dnsNetworks: [
            'enrtree://AKA3AM6LPBYEUDMVNU3BSVQJ5AD45Y7YPOHJLEF6W26QOE4VTUDPE@all.sepolia.ethdisco.net',
        ],
    },
    holesky: {
        name: 'holesky',
        chainId: 17000,
        networkId: 17000,
        defaultHardfork: 'paris',
        consensus: {
            type: 'pos',
            algorithm: 'casper',
        },
        comment: 'PoS test network to replace Goerli',
        url: 'https://github.com/eth-clients/holesky/',
        genesis: {
            baseFeePerGas: '0x3B9ACA00',
            difficulty: '0x01',
            extraData: '0x',
            gasLimit: '0x17D7840',
            nonce: '0x0000000000001234',
            timestamp: '0x65156994',
        },
        hardforks: [
            {
                name: 'chainstart',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'homestead',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'tangerineWhistle',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'spuriousDragon',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'byzantium',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'constantinople',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'petersburg',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'istanbul',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'muirGlacier',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'berlin',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'london',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'paris',
                ttd: '0',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'mergeForkIdTransition',
                block: 0,
                forkHash: '0xc61a6098',
            },
            {
                name: 'shanghai',
                block: null,
                timestamp: '1696000704',
                forkHash: '0xfd4f016b',
            },
            {
                name: 'cancun',
                block: null,
                timestamp: '1707305664',
                forkHash: '0x9b192ad0',
            },
        ],
        bootstrapNodes: [
            {
                ip: '146.190.13.128',
                port: 30303,
                id: 'ac906289e4b7f12df423d654c5a962b6ebe5b3a74cc9e06292a85221f9a64a6f1cfdd6b714ed6dacef51578f92b34c60ee91e9ede9c7f8fadc4d347326d95e2b',
                location: '',
                comment: 'bootnode 1',
            },
            {
                ip: '178.128.136.233',
                port: 30303,
                id: 'a3435a0155a3e837c02f5e7f5662a2f1fbc25b48e4dc232016e1c51b544cb5b4510ef633ea3278c0e970fa8ad8141e2d4d0f9f95456c537ff05fdf9b31c15072',
                location: '',
                comment: 'bootnode 2',
            },
        ],
        dnsNetworks: [
            'enrtree://AKA3AM6LPBYEUDMVNU3BSVQJ5AD45Y7YPOHJLEF6W26QOE4VTUDPE@all.holesky.ethdisco.net',
        ],
    },
    kaustinen: {
        name: 'kaustinen',
        chainId: 69420,
        networkId: 69420,
        defaultHardfork: 'prague',
        consensus: {
            type: 'pos',
            algorithm: 'casper',
        },
        comment: 'Verkle kaustinen testnet 2 (likely temporary, do not hard-wire into production code)',
        url: 'https://github.com/eth-clients/kaustinen/',
        genesis: {
            difficulty: '0x01',
            extraData: '0x',
            gasLimit: '0x17D7840',
            nonce: '0x0000000000001234',
            timestamp: '0x65608a64',
        },
        hardforks: [
            {
                name: 'chainstart',
                block: 0,
            },
            {
                name: 'homestead',
                block: 0,
            },
            {
                name: 'tangerineWhistle',
                block: 0,
            },
            {
                name: 'spuriousDragon',
                block: 0,
            },
            {
                name: 'byzantium',
                block: 0,
            },
            {
                name: 'constantinople',
                block: 0,
            },
            {
                name: 'petersburg',
                block: 0,
            },
            {
                name: 'istanbul',
                block: 0,
            },
            {
                name: 'berlin',
                block: 0,
            },
            {
                name: 'london',
                block: 0,
            },
            {
                name: 'paris',
                ttd: '0',
                block: 0,
            },
            {
                name: 'mergeForkIdTransition',
                block: 0,
            },
            {
                name: 'shanghai',
                block: null,
                timestamp: '0',
            },
            {
                name: 'prague',
                block: null,
                timestamp: '1700825700',
            },
        ],
        bootstrapNodes: [],
        dnsNetworks: [],
    },
};

/**
 * This code was duplicated from https://github.com/alexgorbatchev/crc/ under MIT license.
 * The code below is copied largely unmodified from the below file
 * https://github.com/alexgorbatchev/crc/blob/31fc3853e417b5fb5ec83335428805842575f699/src/calculators/crc32.ts
 */
let TABLE = [
    0x00000000, 0x77073096, 0xee0e612c, 0x990951ba, 0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
    0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988, 0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
    0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de, 0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
    0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec, 0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
    0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172, 0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
    0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940, 0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
    0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116, 0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
    0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924, 0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
    0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a, 0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
    0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818, 0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
    0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e, 0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
    0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c, 0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
    0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2, 0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
    0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0, 0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
    0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086, 0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
    0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4, 0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,
    0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a, 0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
    0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8, 0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
    0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe, 0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
    0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc, 0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5,
    0xd6d6a3e8, 0xa1d1937e, 0x38d8c2c4, 0x4fdff252, 0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
    0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60, 0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79,
    0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236, 0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
    0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04, 0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
    0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a, 0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
    0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38, 0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
    0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e, 0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
    0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c, 0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
    0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2, 0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
    0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0, 0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
    0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6, 0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
    0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94, 0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d,
];
if (typeof Int32Array !== 'undefined') {
    TABLE = new Int32Array(TABLE);
}
const crc = (current, previous) => {
    let crc = previous === 0 ? 0 : ~~previous ^ -1;
    for (let index = 0; index < current.length; index++) {
        crc = TABLE[(crc ^ current[index]) & 0xff] ^ (crc >>> 8);
    }
    return crc ^ -1;
};
const crc32 = (current, previous) => {
    return crc(current, previous) >>> 0;
};

var Chain;
(function (Chain) {
    Chain[Chain["Mainnet"] = 1] = "Mainnet";
    Chain[Chain["Goerli"] = 5] = "Goerli";
    Chain[Chain["Sepolia"] = 11155111] = "Sepolia";
    Chain[Chain["Holesky"] = 17000] = "Holesky";
    Chain[Chain["Kaustinen"] = 69420] = "Kaustinen";
})(Chain || (Chain = {}));
// Having this info as record will force typescript to make sure no chain is missed
/**
 * GenesisState info about well known ethereum chains
 */
({
    [Chain.Mainnet]: {
        name: 'mainnet',
        blockNumber: BIGINT_0,
        stateRoot: hexToBytes('0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544'),
    },
    [Chain.Goerli]: {
        name: 'goerli',
        blockNumber: BIGINT_0,
        stateRoot: hexToBytes('0x5d6cded585e73c4e322c30c2f782a336316f17dd85a4863b9d838d2d4b8b3008'),
    },
    [Chain.Sepolia]: {
        name: 'sepolia',
        blockNumber: BIGINT_0,
        stateRoot: hexToBytes('0x5eb6e371a698b8d68f665192350ffcecbbbf322916f4b51bd79bb6887da3f494'),
    },
    [Chain.Holesky]: {
        name: 'holesky',
        blockNumber: BIGINT_0,
        stateRoot: hexToBytes('0x69d8c9d72f6fa4ad42d4702b433707212f90db395eb54dc20bc85de253788783'),
    },
    [Chain.Kaustinen]: {
        name: 'kaustinen',
        blockNumber: BIGINT_0,
        stateRoot: hexToBytes('0x5e8519756841faf0b2c28951c451b61a4b407b70a5ce5b57992f4bec973173ff'),
    },
});
var Hardfork;
(function (Hardfork) {
    Hardfork["Chainstart"] = "chainstart";
    Hardfork["Homestead"] = "homestead";
    Hardfork["Dao"] = "dao";
    Hardfork["TangerineWhistle"] = "tangerineWhistle";
    Hardfork["SpuriousDragon"] = "spuriousDragon";
    Hardfork["Byzantium"] = "byzantium";
    Hardfork["Constantinople"] = "constantinople";
    Hardfork["Petersburg"] = "petersburg";
    Hardfork["Istanbul"] = "istanbul";
    Hardfork["MuirGlacier"] = "muirGlacier";
    Hardfork["Berlin"] = "berlin";
    Hardfork["London"] = "london";
    Hardfork["ArrowGlacier"] = "arrowGlacier";
    Hardfork["GrayGlacier"] = "grayGlacier";
    Hardfork["MergeForkIdTransition"] = "mergeForkIdTransition";
    Hardfork["Paris"] = "paris";
    Hardfork["Shanghai"] = "shanghai";
    Hardfork["Cancun"] = "cancun";
    Hardfork["Prague"] = "prague";
})(Hardfork || (Hardfork = {}));
var ConsensusType;
(function (ConsensusType) {
    ConsensusType["ProofOfStake"] = "pos";
    ConsensusType["ProofOfWork"] = "pow";
    ConsensusType["ProofOfAuthority"] = "poa";
})(ConsensusType || (ConsensusType = {}));
var ConsensusAlgorithm;
(function (ConsensusAlgorithm) {
    ConsensusAlgorithm["Ethash"] = "ethash";
    ConsensusAlgorithm["Clique"] = "clique";
    ConsensusAlgorithm["Casper"] = "casper";
})(ConsensusAlgorithm || (ConsensusAlgorithm = {}));
var CustomChain;
(function (CustomChain) {
    /**
     * Polygon (Matic) Mainnet
     *
     * - [Documentation](https://docs.matic.network/docs/develop/network-details/network)
     */
    CustomChain["PolygonMainnet"] = "polygon-mainnet";
    /**
     * Polygon (Matic) Mumbai Testnet
     *
     * - [Documentation](https://docs.matic.network/docs/develop/network-details/network)
     */
    CustomChain["PolygonMumbai"] = "polygon-mumbai";
    /**
     * Arbitrum One - mainnet for Arbitrum roll-up
     *
     * - [Documentation](https://developer.offchainlabs.com/public-chains)
     */
    CustomChain["ArbitrumOne"] = "arbitrum-one";
    /**
     * xDai EVM sidechain with a native stable token
     *
     * - [Documentation](https://www.xdaichain.com/)
     */
    CustomChain["xDaiChain"] = "x-dai-chain";
    /**
     * Optimistic Kovan - testnet for Optimism roll-up
     *
     * - [Documentation](https://community.optimism.io/docs/developers/tutorials.html)
     */
    CustomChain["OptimisticKovan"] = "optimistic-kovan";
    /**
     * Optimistic Ethereum - mainnet for Optimism roll-up
     *
     * - [Documentation](https://community.optimism.io/docs/developers/tutorials.html)
     */
    CustomChain["OptimisticEthereum"] = "optimistic-ethereum";
})(CustomChain || (CustomChain = {}));

var Status$1;
(function (Status) {
    Status["Draft"] = "draft";
    Status["Review"] = "review";
    Status["Final"] = "final";
})(Status$1 || (Status$1 = {}));
const EIPs = {
    1153: {
        comment: 'Transient storage opcodes',
        url: 'https://eips.ethereum.org/EIPS/eip-1153',
        status: Status$1.Review,
        minimumHardfork: Hardfork.Chainstart,
        requiredEIPs: [],
        gasPrices: {
            tstore: {
                v: 100,
                d: 'Base fee of the TSTORE opcode',
            },
            tload: {
                v: 100,
                d: 'Base fee of the TLOAD opcode',
            },
        },
    },
    1559: {
        comment: 'Fee market change for ETH 1.0 chain',
        url: 'https://eips.ethereum.org/EIPS/eip-1559',
        status: Status$1.Final,
        minimumHardfork: Hardfork.Berlin,
        requiredEIPs: [2930],
        gasConfig: {
            baseFeeMaxChangeDenominator: {
                v: 8,
                d: 'Maximum base fee change denominator',
            },
            elasticityMultiplier: {
                v: 2,
                d: 'Maximum block gas target elasticity',
            },
            initialBaseFee: {
                v: 1000000000,
                d: 'Initial base fee on first EIP1559 block',
            },
        },
    },
    2315: {
        comment: 'Simple subroutines for the EVM',
        url: 'https://eips.ethereum.org/EIPS/eip-2315',
        status: Status$1.Draft,
        minimumHardfork: Hardfork.Istanbul,
        requiredEIPs: [],
        gasPrices: {
            beginsub: {
                v: 2,
                d: 'Base fee of the BEGINSUB opcode',
            },
            returnsub: {
                v: 5,
                d: 'Base fee of the RETURNSUB opcode',
            },
            jumpsub: {
                v: 10,
                d: 'Base fee of the JUMPSUB opcode',
            },
        },
    },
    2565: {
        comment: 'ModExp gas cost',
        url: 'https://eips.ethereum.org/EIPS/eip-2565',
        status: Status$1.Final,
        minimumHardfork: Hardfork.Byzantium,
        requiredEIPs: [],
        gasPrices: {
            modexpGquaddivisor: {
                v: 3,
                d: 'Gquaddivisor from modexp precompile for gas calculation',
            },
        },
    },
    2718: {
        comment: 'Typed Transaction Envelope',
        url: 'https://eips.ethereum.org/EIPS/eip-2718',
        status: Status$1.Final,
        minimumHardfork: Hardfork.Chainstart,
        requiredEIPs: [],
    },
    2929: {
        comment: 'Gas cost increases for state access opcodes',
        url: 'https://eips.ethereum.org/EIPS/eip-2929',
        status: Status$1.Final,
        minimumHardfork: Hardfork.Chainstart,
        requiredEIPs: [],
        gasPrices: {
            coldsload: {
                v: 2100,
                d: 'Gas cost of the first read of storage from a given location (per transaction)',
            },
            coldaccountaccess: {
                v: 2600,
                d: 'Gas cost of the first read of a given address (per transaction)',
            },
            warmstorageread: {
                v: 100,
                d: "Gas cost of reading storage locations which have already loaded 'cold'",
            },
            sstoreCleanGasEIP2200: {
                v: 2900,
                d: 'Once per SSTORE operation from clean non-zero to something else',
            },
            sstoreNoopGasEIP2200: {
                v: 100,
                d: "Once per SSTORE operation if the value doesn't change",
            },
            sstoreDirtyGasEIP2200: {
                v: 100,
                d: 'Once per SSTORE operation if a dirty value is changed',
            },
            sstoreInitRefundEIP2200: {
                v: 19900,
                d: 'Once per SSTORE operation for resetting to the original zero value',
            },
            sstoreCleanRefundEIP2200: {
                v: 4900,
                d: 'Once per SSTORE operation for resetting to the original non-zero value',
            },
            call: {
                v: 0,
                d: 'Base fee of the CALL opcode',
            },
            callcode: {
                v: 0,
                d: 'Base fee of the CALLCODE opcode',
            },
            delegatecall: {
                v: 0,
                d: 'Base fee of the DELEGATECALL opcode',
            },
            staticcall: {
                v: 0,
                d: 'Base fee of the STATICCALL opcode',
            },
            balance: {
                v: 0,
                d: 'Base fee of the BALANCE opcode',
            },
            extcodesize: {
                v: 0,
                d: 'Base fee of the EXTCODESIZE opcode',
            },
            extcodecopy: {
                v: 0,
                d: 'Base fee of the EXTCODECOPY opcode',
            },
            extcodehash: {
                v: 0,
                d: 'Base fee of the EXTCODEHASH opcode',
            },
            sload: {
                v: 0,
                d: 'Base fee of the SLOAD opcode',
            },
            sstore: {
                v: 0,
                d: 'Base fee of the SSTORE opcode',
            },
        },
    },
    2930: {
        comment: 'Optional access lists',
        url: 'https://eips.ethereum.org/EIPS/eip-2930',
        status: Status$1.Final,
        minimumHardfork: Hardfork.Istanbul,
        requiredEIPs: [2718, 2929],
        gasPrices: {
            accessListStorageKeyCost: {
                v: 1900,
                d: 'Gas cost per storage key in an Access List transaction',
            },
            accessListAddressCost: {
                v: 2400,
                d: 'Gas cost per storage key in an Access List transaction',
            },
        },
    },
    3074: {
        comment: 'AUTH and AUTHCALL opcodes',
        url: 'https://eips.ethereum.org/EIPS/eip-3074',
        status: Status$1.Review,
        minimumHardfork: Hardfork.London,
        requiredEIPs: [],
        gasPrices: {
            auth: {
                v: 3100,
                d: 'Gas cost of the AUTH opcode',
            },
            authcall: {
                v: 0,
                d: 'Gas cost of the AUTHCALL opcode',
            },
            authcallValueTransfer: {
                v: 6700,
                d: 'Paid for CALL when the value transfer is non-zero',
            },
        },
    },
    3198: {
        comment: 'BASEFEE opcode',
        url: 'https://eips.ethereum.org/EIPS/eip-3198',
        status: Status$1.Final,
        minimumHardfork: Hardfork.London,
        requiredEIPs: [],
        gasPrices: {
            basefee: {
                v: 2,
                d: 'Gas cost of the BASEFEE opcode',
            },
        },
    },
    3529: {
        comment: 'Reduction in refunds',
        url: 'https://eips.ethereum.org/EIPS/eip-3529',
        status: Status$1.Final,
        minimumHardfork: Hardfork.Berlin,
        requiredEIPs: [2929],
        gasConfig: {
            maxRefundQuotient: {
                v: 5,
                d: 'Maximum refund quotient; max tx refund is min(tx.gasUsed/maxRefundQuotient, tx.gasRefund)',
            },
        },
        gasPrices: {
            selfdestructRefund: {
                v: 0,
                d: 'Refunded following a selfdestruct operation',
            },
            sstoreClearRefundEIP2200: {
                v: 4800,
                d: 'Once per SSTORE operation for clearing an originally existing storage slot',
            },
        },
    },
    3540: {
        comment: 'EVM Object Format (EOF) v1',
        url: 'https://eips.ethereum.org/EIPS/eip-3540',
        status: Status$1.Review,
        minimumHardfork: Hardfork.London,
        requiredEIPs: [3541],
    },
    3541: {
        comment: 'Reject new contracts starting with the 0xEF byte',
        url: 'https://eips.ethereum.org/EIPS/eip-3541',
        status: Status$1.Final,
        minimumHardfork: Hardfork.Berlin,
        requiredEIPs: [],
    },
    3554: {
        comment: 'Difficulty Bomb Delay to December 1st 2021',
        url: 'https://eips.ethereum.org/EIPS/eip-3554',
        status: Status$1.Final,
        minimumHardfork: Hardfork.MuirGlacier,
        requiredEIPs: [],
        pow: {
            difficultyBombDelay: {
                v: 9500000,
                d: 'the amount of blocks to delay the difficulty bomb with',
            },
        },
    },
    3607: {
        comment: 'Reject transactions from senders with deployed code',
        url: 'https://eips.ethereum.org/EIPS/eip-3607',
        status: Status$1.Final,
        minimumHardfork: Hardfork.Chainstart,
        requiredEIPs: [],
    },
    3651: {
        comment: 'Warm COINBASE',
        url: 'https://eips.ethereum.org/EIPS/eip-3651',
        status: Status$1.Review,
        minimumHardfork: Hardfork.London,
        requiredEIPs: [2929],
    },
    3670: {
        comment: 'EOF - Code Validation',
        url: 'https://eips.ethereum.org/EIPS/eip-3670',
        status: 'Review',
        minimumHardfork: Hardfork.London,
        requiredEIPs: [3540],
        gasConfig: {},
        gasPrices: {},
        vm: {},
        pow: {},
    },
    3675: {
        comment: 'Upgrade consensus to Proof-of-Stake',
        url: 'https://eips.ethereum.org/EIPS/eip-3675',
        status: Status$1.Final,
        minimumHardfork: Hardfork.London,
        requiredEIPs: [],
    },
    3855: {
        comment: 'PUSH0 instruction',
        url: 'https://eips.ethereum.org/EIPS/eip-3855',
        status: Status$1.Review,
        minimumHardfork: Hardfork.Chainstart,
        requiredEIPs: [],
        gasPrices: {
            push0: {
                v: 2,
                d: 'Base fee of the PUSH0 opcode',
            },
        },
    },
    3860: {
        comment: 'Limit and meter initcode',
        url: 'https://eips.ethereum.org/EIPS/eip-3860',
        status: Status$1.Review,
        minimumHardfork: Hardfork.SpuriousDragon,
        requiredEIPs: [],
        gasPrices: {
            initCodeWordCost: {
                v: 2,
                d: 'Gas to pay for each word (32 bytes) of initcode when creating a contract',
            },
        },
        vm: {
            maxInitCodeSize: {
                v: 49152,
                d: 'Maximum length of initialization code when creating a contract',
            },
        },
    },
    4345: {
        comment: 'Difficulty Bomb Delay to June 2022',
        url: 'https://eips.ethereum.org/EIPS/eip-4345',
        status: Status$1.Final,
        minimumHardfork: Hardfork.London,
        requiredEIPs: [],
        pow: {
            difficultyBombDelay: {
                v: 10700000,
                d: 'the amount of blocks to delay the difficulty bomb with',
            },
        },
    },
    4399: {
        comment: 'Supplant DIFFICULTY opcode with PREVRANDAO',
        url: 'https://eips.ethereum.org/EIPS/eip-4399',
        status: Status$1.Review,
        minimumHardfork: Hardfork.London,
        requiredEIPs: [],
        gasPrices: {
            prevrandao: {
                v: 2,
                d: 'Base fee of the PREVRANDAO opcode (previously DIFFICULTY)',
            },
        },
    },
    4788: {
        comment: 'Beacon block root in the EVM',
        url: 'https://eips.ethereum.org/EIPS/eip-4788',
        status: Status$1.Draft,
        minimumHardfork: Hardfork.Cancun,
        requiredEIPs: [],
        gasPrices: {},
        vm: {
            historicalRootsLength: {
                v: 8191,
                d: 'The modulo parameter of the beaconroot ring buffer in the beaconroot statefull precompile',
            },
        },
    },
    4844: {
        comment: 'Shard Blob Transactions',
        url: 'https://eips.ethereum.org/EIPS/eip-4844',
        status: Status$1.Draft,
        minimumHardfork: Hardfork.Paris,
        requiredEIPs: [1559, 2718, 2930, 4895],
        gasConfig: {
            blobGasPerBlob: {
                v: 131072,
                d: 'The base fee for blob gas per blob',
            },
            targetBlobGasPerBlock: {
                v: 393216,
                d: 'The target blob gas consumed per block',
            },
            maxblobGasPerBlock: {
                v: 786432,
                d: 'The max blob gas allowable per block',
            },
            blobGasPriceUpdateFraction: {
                v: 3338477,
                d: 'The denominator used in the exponential when calculating a blob gas price',
            },
        },
        gasPrices: {
            simpleGasPerBlob: {
                v: 12000,
                d: 'The basic gas fee for each blob',
            },
            minBlobGasPrice: {
                v: 1,
                d: 'The minimum fee per blob gas',
            },
            kzgPointEvaluationGasPrecompilePrice: {
                v: 50000,
                d: 'The fee associated with the point evaluation precompile',
            },
            blobhash: {
                v: 3,
                d: 'Base fee of the BLOBHASH opcode',
            },
        },
        sharding: {
            blobCommitmentVersionKzg: {
                v: 1,
                d: 'The number indicated a versioned hash is a KZG commitment',
            },
            fieldElementsPerBlob: {
                v: 4096,
                d: 'The number of field elements allowed per blob',
            },
        },
    },
    4895: {
        comment: 'Beacon chain push withdrawals as operations',
        url: 'https://eips.ethereum.org/EIPS/eip-4895',
        status: Status$1.Review,
        minimumHardfork: Hardfork.Paris,
        requiredEIPs: [],
    },
    5133: {
        comment: 'Delaying Difficulty Bomb to mid-September 2022',
        url: 'https://eips.ethereum.org/EIPS/eip-5133',
        status: Status$1.Draft,
        minimumHardfork: Hardfork.GrayGlacier,
        requiredEIPs: [],
        pow: {
            difficultyBombDelay: {
                v: 11400000,
                d: 'the amount of blocks to delay the difficulty bomb with',
            },
        },
    },
    5656: {
        comment: 'MCOPY - Memory copying instruction',
        url: 'https://eips.ethereum.org/EIPS/eip-5656',
        status: Status$1.Draft,
        minimumHardfork: Hardfork.Shanghai,
        requiredEIPs: [],
        gasPrices: {
            mcopy: {
                v: 3,
                d: 'Base fee of the MCOPY opcode',
            },
        },
    },
    6780: {
        comment: 'SELFDESTRUCT only in same transaction',
        url: 'https://eips.ethereum.org/EIPS/eip-6780',
        status: Status$1.Draft,
        minimumHardfork: Hardfork.London,
        requiredEIPs: [],
    },
    6800: {
        comment: 'Ethereum state using a unified verkle tree (experimental)',
        url: 'https://github.com/ethereum/EIPs/pull/6800',
        status: Status$1.Draft,
        minimumHardfork: Hardfork.London,
        requiredEIPs: [],
    },
    7516: {
        comment: 'BLOBBASEFEE opcode',
        url: 'https://eips.ethereum.org/EIPS/eip-7516',
        status: Status$1.Draft,
        minimumHardfork: Hardfork.Paris,
        requiredEIPs: [4844],
        gasPrices: {
            blobbasefee: {
                v: 2,
                d: 'Gas cost of the BLOBBASEFEE opcode',
            },
        },
    },
};

var Status;
(function (Status) {
    Status["Draft"] = "draft";
    Status["Review"] = "review";
    Status["Final"] = "final";
})(Status || (Status = {}));
const hardforks = {
    chainstart: {
        name: 'chainstart',
        comment: 'Start of the Ethereum main chain',
        url: '',
        status: Status.Final,
        gasConfig: {
            minGasLimit: {
                v: 5000,
                d: 'Minimum the gas limit may ever be',
            },
            gasLimitBoundDivisor: {
                v: 1024,
                d: 'The bound divisor of the gas limit, used in update calculations',
            },
            maxRefundQuotient: {
                v: 2,
                d: 'Maximum refund quotient; max tx refund is min(tx.gasUsed/maxRefundQuotient, tx.gasRefund)',
            },
        },
        gasPrices: {
            base: {
                v: 2,
                d: 'Gas base cost, used e.g. for ChainID opcode (Istanbul)',
            },
            exp: {
                v: 10,
                d: 'Base fee of the EXP opcode',
            },
            expByte: {
                v: 10,
                d: 'Times ceil(log256(exponent)) for the EXP instruction',
            },
            keccak256: {
                v: 30,
                d: 'Base fee of the SHA3 opcode',
            },
            keccak256Word: {
                v: 6,
                d: "Once per word of the SHA3 operation's data",
            },
            sload: {
                v: 50,
                d: 'Base fee of the SLOAD opcode',
            },
            sstoreSet: {
                v: 20000,
                d: 'Once per SSTORE operation if the zeroness changes from zero',
            },
            sstoreReset: {
                v: 5000,
                d: 'Once per SSTORE operation if the zeroness does not change from zero',
            },
            sstoreRefund: {
                v: 15000,
                d: 'Once per SSTORE operation if the zeroness changes to zero',
            },
            jumpdest: {
                v: 1,
                d: 'Base fee of the JUMPDEST opcode',
            },
            log: {
                v: 375,
                d: 'Base fee of the LOG opcode',
            },
            logData: {
                v: 8,
                d: "Per byte in a LOG* operation's data",
            },
            logTopic: {
                v: 375,
                d: 'Multiplied by the * of the LOG*, per LOG transaction. e.g. LOG0 incurs 0 * c_txLogTopicGas, LOG4 incurs 4 * c_txLogTopicGas',
            },
            create: {
                v: 32000,
                d: 'Base fee of the CREATE opcode',
            },
            call: {
                v: 40,
                d: 'Base fee of the CALL opcode',
            },
            callStipend: {
                v: 2300,
                d: 'Free gas given at beginning of call',
            },
            callValueTransfer: {
                v: 9000,
                d: 'Paid for CALL when the value transfor is non-zero',
            },
            callNewAccount: {
                v: 25000,
                d: "Paid for CALL when the destination address didn't exist prior",
            },
            selfdestructRefund: {
                v: 24000,
                d: 'Refunded following a selfdestruct operation',
            },
            memory: {
                v: 3,
                d: 'Times the address of the (highest referenced byte in memory + 1). NOTE: referencing happens on read, write and in instructions such as RETURN and CALL',
            },
            quadCoeffDiv: {
                v: 512,
                d: 'Divisor for the quadratic particle of the memory cost equation',
            },
            createData: {
                v: 200,
                d: '',
            },
            tx: {
                v: 21000,
                d: 'Per transaction. NOTE: Not payable on data of calls between transactions',
            },
            txCreation: {
                v: 32000,
                d: 'The cost of creating a contract via tx',
            },
            txDataZero: {
                v: 4,
                d: 'Per byte of data attached to a transaction that equals zero. NOTE: Not payable on data of calls between transactions',
            },
            txDataNonZero: {
                v: 68,
                d: 'Per byte of data attached to a transaction that is not equal to zero. NOTE: Not payable on data of calls between transactions',
            },
            copy: {
                v: 3,
                d: 'Multiplied by the number of 32-byte words that are copied (round up) for any *COPY operation and added',
            },
            ecRecover: {
                v: 3000,
                d: '',
            },
            sha256: {
                v: 60,
                d: '',
            },
            sha256Word: {
                v: 12,
                d: '',
            },
            ripemd160: {
                v: 600,
                d: '',
            },
            ripemd160Word: {
                v: 120,
                d: '',
            },
            identity: {
                v: 15,
                d: '',
            },
            identityWord: {
                v: 3,
                d: '',
            },
            stop: {
                v: 0,
                d: 'Base fee of the STOP opcode',
            },
            add: {
                v: 3,
                d: 'Base fee of the ADD opcode',
            },
            mul: {
                v: 5,
                d: 'Base fee of the MUL opcode',
            },
            sub: {
                v: 3,
                d: 'Base fee of the SUB opcode',
            },
            div: {
                v: 5,
                d: 'Base fee of the DIV opcode',
            },
            sdiv: {
                v: 5,
                d: 'Base fee of the SDIV opcode',
            },
            mod: {
                v: 5,
                d: 'Base fee of the MOD opcode',
            },
            smod: {
                v: 5,
                d: 'Base fee of the SMOD opcode',
            },
            addmod: {
                v: 8,
                d: 'Base fee of the ADDMOD opcode',
            },
            mulmod: {
                v: 8,
                d: 'Base fee of the MULMOD opcode',
            },
            signextend: {
                v: 5,
                d: 'Base fee of the SIGNEXTEND opcode',
            },
            lt: {
                v: 3,
                d: 'Base fee of the LT opcode',
            },
            gt: {
                v: 3,
                d: 'Base fee of the GT opcode',
            },
            slt: {
                v: 3,
                d: 'Base fee of the SLT opcode',
            },
            sgt: {
                v: 3,
                d: 'Base fee of the SGT opcode',
            },
            eq: {
                v: 3,
                d: 'Base fee of the EQ opcode',
            },
            iszero: {
                v: 3,
                d: 'Base fee of the ISZERO opcode',
            },
            and: {
                v: 3,
                d: 'Base fee of the AND opcode',
            },
            or: {
                v: 3,
                d: 'Base fee of the OR opcode',
            },
            xor: {
                v: 3,
                d: 'Base fee of the XOR opcode',
            },
            not: {
                v: 3,
                d: 'Base fee of the NOT opcode',
            },
            byte: {
                v: 3,
                d: 'Base fee of the BYTE opcode',
            },
            address: {
                v: 2,
                d: 'Base fee of the ADDRESS opcode',
            },
            balance: {
                v: 20,
                d: 'Base fee of the BALANCE opcode',
            },
            origin: {
                v: 2,
                d: 'Base fee of the ORIGIN opcode',
            },
            caller: {
                v: 2,
                d: 'Base fee of the CALLER opcode',
            },
            callvalue: {
                v: 2,
                d: 'Base fee of the CALLVALUE opcode',
            },
            calldataload: {
                v: 3,
                d: 'Base fee of the CALLDATALOAD opcode',
            },
            calldatasize: {
                v: 2,
                d: 'Base fee of the CALLDATASIZE opcode',
            },
            calldatacopy: {
                v: 3,
                d: 'Base fee of the CALLDATACOPY opcode',
            },
            codesize: {
                v: 2,
                d: 'Base fee of the CODESIZE opcode',
            },
            codecopy: {
                v: 3,
                d: 'Base fee of the CODECOPY opcode',
            },
            gasprice: {
                v: 2,
                d: 'Base fee of the GASPRICE opcode',
            },
            extcodesize: {
                v: 20,
                d: 'Base fee of the EXTCODESIZE opcode',
            },
            extcodecopy: {
                v: 20,
                d: 'Base fee of the EXTCODECOPY opcode',
            },
            blockhash: {
                v: 20,
                d: 'Base fee of the BLOCKHASH opcode',
            },
            coinbase: {
                v: 2,
                d: 'Base fee of the COINBASE opcode',
            },
            timestamp: {
                v: 2,
                d: 'Base fee of the TIMESTAMP opcode',
            },
            number: {
                v: 2,
                d: 'Base fee of the NUMBER opcode',
            },
            difficulty: {
                v: 2,
                d: 'Base fee of the DIFFICULTY opcode',
            },
            gaslimit: {
                v: 2,
                d: 'Base fee of the GASLIMIT opcode',
            },
            pop: {
                v: 2,
                d: 'Base fee of the POP opcode',
            },
            mload: {
                v: 3,
                d: 'Base fee of the MLOAD opcode',
            },
            mstore: {
                v: 3,
                d: 'Base fee of the MSTORE opcode',
            },
            mstore8: {
                v: 3,
                d: 'Base fee of the MSTORE8 opcode',
            },
            sstore: {
                v: 0,
                d: 'Base fee of the SSTORE opcode',
            },
            jump: {
                v: 8,
                d: 'Base fee of the JUMP opcode',
            },
            jumpi: {
                v: 10,
                d: 'Base fee of the JUMPI opcode',
            },
            pc: {
                v: 2,
                d: 'Base fee of the PC opcode',
            },
            msize: {
                v: 2,
                d: 'Base fee of the MSIZE opcode',
            },
            gas: {
                v: 2,
                d: 'Base fee of the GAS opcode',
            },
            push: {
                v: 3,
                d: 'Base fee of the PUSH opcode',
            },
            dup: {
                v: 3,
                d: 'Base fee of the DUP opcode',
            },
            swap: {
                v: 3,
                d: 'Base fee of the SWAP opcode',
            },
            callcode: {
                v: 40,
                d: 'Base fee of the CALLCODE opcode',
            },
            return: {
                v: 0,
                d: 'Base fee of the RETURN opcode',
            },
            invalid: {
                v: 0,
                d: 'Base fee of the INVALID opcode',
            },
            selfdestruct: {
                v: 0,
                d: 'Base fee of the SELFDESTRUCT opcode',
            },
        },
        vm: {
            stackLimit: {
                v: 1024,
                d: 'Maximum size of VM stack allowed',
            },
            callCreateDepth: {
                v: 1024,
                d: 'Maximum depth of call/create stack',
            },
            maxExtraDataSize: {
                v: 32,
                d: 'Maximum size extra data may be after Genesis',
            },
        },
        pow: {
            minimumDifficulty: {
                v: 131072,
                d: 'The minimum that the difficulty may ever be',
            },
            difficultyBoundDivisor: {
                v: 2048,
                d: 'The bound divisor of the difficulty, used in the update calculations',
            },
            durationLimit: {
                v: 13,
                d: 'The decision boundary on the blocktime duration used to determine whether difficulty should go up or not',
            },
            epochDuration: {
                v: 30000,
                d: 'Duration between proof-of-work epochs',
            },
            timebombPeriod: {
                v: 100000,
                d: 'Exponential difficulty timebomb period',
            },
            minerReward: {
                v: BigInt('5000000000000000000'),
                d: 'the amount a miner get rewarded for mining a block',
            },
            difficultyBombDelay: {
                v: 0,
                d: 'the amount of blocks to delay the difficulty bomb with',
            },
        },
    },
    homestead: {
        name: 'homestead',
        comment: 'Homestead hardfork with protocol and network changes',
        url: 'https://eips.ethereum.org/EIPS/eip-606',
        status: Status.Final,
        gasPrices: {
            delegatecall: {
                v: 40,
                d: 'Base fee of the DELEGATECALL opcode',
            },
        },
    },
    dao: {
        name: 'dao',
        comment: 'DAO rescue hardfork',
        url: 'https://eips.ethereum.org/EIPS/eip-779',
        status: Status.Final,
    },
    tangerineWhistle: {
        name: 'tangerineWhistle',
        comment: 'Hardfork with gas cost changes for IO-heavy operations',
        url: 'https://eips.ethereum.org/EIPS/eip-608',
        status: Status.Final,
        gasPrices: {
            sload: {
                v: 200,
                d: 'Once per SLOAD operation',
            },
            call: {
                v: 700,
                d: 'Once per CALL operation & message call transaction',
            },
            extcodesize: {
                v: 700,
                d: 'Base fee of the EXTCODESIZE opcode',
            },
            extcodecopy: {
                v: 700,
                d: 'Base fee of the EXTCODECOPY opcode',
            },
            balance: {
                v: 400,
                d: 'Base fee of the BALANCE opcode',
            },
            delegatecall: {
                v: 700,
                d: 'Base fee of the DELEGATECALL opcode',
            },
            callcode: {
                v: 700,
                d: 'Base fee of the CALLCODE opcode',
            },
            selfdestruct: {
                v: 5000,
                d: 'Base fee of the SELFDESTRUCT opcode',
            },
        },
    },
    spuriousDragon: {
        name: 'spuriousDragon',
        comment: 'HF with EIPs for simple replay attack protection, EXP cost increase, state trie clearing, contract code size limit',
        url: 'https://eips.ethereum.org/EIPS/eip-607',
        status: Status.Final,
        gasPrices: {
            expByte: {
                v: 50,
                d: 'Times ceil(log256(exponent)) for the EXP instruction',
            },
        },
        vm: {
            maxCodeSize: {
                v: 24576,
                d: 'Maximum length of contract code',
            },
        },
    },
    byzantium: {
        name: 'byzantium',
        comment: 'Hardfork with new precompiles, instructions and other protocol changes',
        url: 'https://eips.ethereum.org/EIPS/eip-609',
        status: Status.Final,
        gasPrices: {
            modexpGquaddivisor: {
                v: 20,
                d: 'Gquaddivisor from modexp precompile for gas calculation',
            },
            ecAdd: {
                v: 500,
                d: 'Gas costs for curve addition precompile',
            },
            ecMul: {
                v: 40000,
                d: 'Gas costs for curve multiplication precompile',
            },
            ecPairing: {
                v: 100000,
                d: 'Base gas costs for curve pairing precompile',
            },
            ecPairingWord: {
                v: 80000,
                d: 'Gas costs regarding curve pairing precompile input length',
            },
            revert: {
                v: 0,
                d: 'Base fee of the REVERT opcode',
            },
            staticcall: {
                v: 700,
                d: 'Base fee of the STATICCALL opcode',
            },
            returndatasize: {
                v: 2,
                d: 'Base fee of the RETURNDATASIZE opcode',
            },
            returndatacopy: {
                v: 3,
                d: 'Base fee of the RETURNDATACOPY opcode',
            },
        },
        pow: {
            minerReward: {
                v: BigInt('3000000000000000000'),
                d: 'the amount a miner get rewarded for mining a block',
            },
            difficultyBombDelay: {
                v: 3000000,
                d: 'the amount of blocks to delay the difficulty bomb with',
            },
        },
    },
    constantinople: {
        name: 'constantinople',
        comment: 'Postponed hardfork including EIP-1283 (SSTORE gas metering changes)',
        url: 'https://eips.ethereum.org/EIPS/eip-1013',
        status: Status.Final,
        gasPrices: {
            netSstoreNoopGas: {
                v: 200,
                d: "Once per SSTORE operation if the value doesn't change",
            },
            netSstoreInitGas: {
                v: 20000,
                d: 'Once per SSTORE operation from clean zero',
            },
            netSstoreCleanGas: {
                v: 5000,
                d: 'Once per SSTORE operation from clean non-zero',
            },
            netSstoreDirtyGas: {
                v: 200,
                d: 'Once per SSTORE operation from dirty',
            },
            netSstoreClearRefund: {
                v: 15000,
                d: 'Once per SSTORE operation for clearing an originally existing storage slot',
            },
            netSstoreResetRefund: {
                v: 4800,
                d: 'Once per SSTORE operation for resetting to the original non-zero value',
            },
            netSstoreResetClearRefund: {
                v: 19800,
                d: 'Once per SSTORE operation for resetting to the original zero value',
            },
            shl: {
                v: 3,
                d: 'Base fee of the SHL opcode',
            },
            shr: {
                v: 3,
                d: 'Base fee of the SHR opcode',
            },
            sar: {
                v: 3,
                d: 'Base fee of the SAR opcode',
            },
            extcodehash: {
                v: 400,
                d: 'Base fee of the EXTCODEHASH opcode',
            },
            create2: {
                v: 32000,
                d: 'Base fee of the CREATE2 opcode',
            },
        },
        pow: {
            minerReward: {
                v: BigInt('2000000000000000000'),
                d: 'The amount a miner gets rewarded for mining a block',
            },
            difficultyBombDelay: {
                v: 5000000,
                d: 'the amount of blocks to delay the difficulty bomb with',
            },
        },
    },
    petersburg: {
        name: 'petersburg',
        comment: 'Aka constantinopleFix, removes EIP-1283, activate together with or after constantinople',
        url: 'https://eips.ethereum.org/EIPS/eip-1716',
        status: Status.Final,
        gasPrices: {
            netSstoreNoopGas: {
                v: null,
                d: 'Removed along EIP-1283',
            },
            netSstoreInitGas: {
                v: null,
                d: 'Removed along EIP-1283',
            },
            netSstoreCleanGas: {
                v: null,
                d: 'Removed along EIP-1283',
            },
            netSstoreDirtyGas: {
                v: null,
                d: 'Removed along EIP-1283',
            },
            netSstoreClearRefund: {
                v: null,
                d: 'Removed along EIP-1283',
            },
            netSstoreResetRefund: {
                v: null,
                d: 'Removed along EIP-1283',
            },
            netSstoreResetClearRefund: {
                v: null,
                d: 'Removed along EIP-1283',
            },
        },
    },
    istanbul: {
        name: 'istanbul',
        comment: 'HF targeted for December 2019 following the Constantinople/Petersburg HF',
        url: 'https://eips.ethereum.org/EIPS/eip-1679',
        status: Status.Final,
        gasConfig: {},
        gasPrices: {
            blake2Round: {
                v: 1,
                d: 'Gas cost per round for the Blake2 F precompile',
            },
            ecAdd: {
                v: 150,
                d: 'Gas costs for curve addition precompile',
            },
            ecMul: {
                v: 6000,
                d: 'Gas costs for curve multiplication precompile',
            },
            ecPairing: {
                v: 45000,
                d: 'Base gas costs for curve pairing precompile',
            },
            ecPairingWord: {
                v: 34000,
                d: 'Gas costs regarding curve pairing precompile input length',
            },
            txDataNonZero: {
                v: 16,
                d: 'Per byte of data attached to a transaction that is not equal to zero. NOTE: Not payable on data of calls between transactions',
            },
            sstoreSentryGasEIP2200: {
                v: 2300,
                d: 'Minimum gas required to be present for an SSTORE call, not consumed',
            },
            sstoreNoopGasEIP2200: {
                v: 800,
                d: "Once per SSTORE operation if the value doesn't change",
            },
            sstoreDirtyGasEIP2200: {
                v: 800,
                d: 'Once per SSTORE operation if a dirty value is changed',
            },
            sstoreInitGasEIP2200: {
                v: 20000,
                d: 'Once per SSTORE operation from clean zero to non-zero',
            },
            sstoreInitRefundEIP2200: {
                v: 19200,
                d: 'Once per SSTORE operation for resetting to the original zero value',
            },
            sstoreCleanGasEIP2200: {
                v: 5000,
                d: 'Once per SSTORE operation from clean non-zero to something else',
            },
            sstoreCleanRefundEIP2200: {
                v: 4200,
                d: 'Once per SSTORE operation for resetting to the original non-zero value',
            },
            sstoreClearRefundEIP2200: {
                v: 15000,
                d: 'Once per SSTORE operation for clearing an originally existing storage slot',
            },
            balance: {
                v: 700,
                d: 'Base fee of the BALANCE opcode',
            },
            extcodehash: {
                v: 700,
                d: 'Base fee of the EXTCODEHASH opcode',
            },
            chainid: {
                v: 2,
                d: 'Base fee of the CHAINID opcode',
            },
            selfbalance: {
                v: 5,
                d: 'Base fee of the SELFBALANCE opcode',
            },
            sload: {
                v: 800,
                d: 'Base fee of the SLOAD opcode',
            },
        },
    },
    muirGlacier: {
        name: 'muirGlacier',
        comment: 'HF to delay the difficulty bomb',
        url: 'https://eips.ethereum.org/EIPS/eip-2384',
        status: Status.Final,
        pow: {
            difficultyBombDelay: {
                v: 9000000,
                d: 'the amount of blocks to delay the difficulty bomb with',
            },
        },
    },
    berlin: {
        name: 'berlin',
        comment: 'HF targeted for July 2020 following the Muir Glacier HF',
        url: 'https://eips.ethereum.org/EIPS/eip-2070',
        status: Status.Final,
        eips: [2565, 2929, 2718, 2930],
    },
    london: {
        name: 'london',
        comment: 'HF targeted for July 2021 following the Berlin fork',
        url: 'https://github.com/ethereum/eth1.0-specs/blob/master/network-upgrades/mainnet-upgrades/london.md',
        status: Status.Final,
        eips: [1559, 3198, 3529, 3541],
    },
    arrowGlacier: {
        name: 'arrowGlacier',
        comment: 'HF to delay the difficulty bomb',
        url: 'https://github.com/ethereum/execution-specs/blob/master/network-upgrades/mainnet-upgrades/arrow-glacier.md',
        status: Status.Final,
        eips: [4345],
    },
    grayGlacier: {
        name: 'grayGlacier',
        comment: 'Delaying the difficulty bomb to Mid September 2022',
        url: 'https://github.com/ethereum/execution-specs/blob/master/network-upgrades/mainnet-upgrades/gray-glacier.md',
        status: Status.Final,
        eips: [5133],
    },
    paris: {
        name: 'paris',
        comment: 'Hardfork to upgrade the consensus mechanism to Proof-of-Stake',
        url: 'https://github.com/ethereum/execution-specs/blob/master/network-upgrades/mainnet-upgrades/merge.md',
        status: Status.Final,
        consensus: {
            type: 'pos',
            algorithm: 'casper',
            casper: {},
        },
        eips: [3675, 4399],
    },
    mergeForkIdTransition: {
        name: 'mergeForkIdTransition',
        comment: 'Pre-merge hardfork to fork off non-upgraded clients',
        url: 'https://eips.ethereum.org/EIPS/eip-3675',
        status: Status.Final,
        eips: [],
    },
    shanghai: {
        name: 'shanghai',
        comment: 'Next feature hardfork after the merge hardfork having withdrawals, warm coinbase, push0, limit/meter initcode',
        url: 'https://github.com/ethereum/execution-specs/blob/master/network-upgrades/mainnet-upgrades/shanghai.md',
        status: Status.Final,
        eips: [3651, 3855, 3860, 4895],
    },
    cancun: {
        name: 'cancun',
        comment: 'Next feature hardfork after shanghai, includes proto-danksharding EIP 4844 blobs (still WIP hence not for production use), transient storage opcodes, parent beacon block root availability in EVM, selfdestruct only in same transaction, and blob base fee opcode',
        url: 'https://github.com/ethereum/execution-specs/blob/master/network-upgrades/mainnet-upgrades/cancun.md',
        status: Status.Final,
        eips: [1153, 4844, 4788, 5656, 6780, 7516],
    },
    prague: {
        name: 'prague',
        comment: 'Next feature hardfork after cancun, internally used for verkle testing/implementation (incomplete/experimental)',
        url: 'https://github.com/ethereum/execution-specs/blob/master/network-upgrades/mainnet-upgrades/prague.md',
        status: Status.Draft,
        eips: [6800],
    },
};

/**
 * Transforms Geth formatted nonce (i.e. hex string) to 8 byte 0x-prefixed string used internally
 * @param nonce string parsed from the Geth genesis file
 * @returns nonce as a 0x-prefixed 8 byte string
 */
function formatNonce(nonce) {
    if (!nonce || nonce === '0x0') {
        return '0x0000000000000000';
    }
    if (isHexPrefixed(nonce)) {
        return '0x' + stripHexPrefix(nonce).padStart(16, '0');
    }
    return '0x' + nonce.padStart(16, '0');
}
/**
 * Converts Geth genesis parameters to an EthereumJS compatible `CommonOpts` object
 * @param json object representing the Geth genesis file
 * @param optional mergeForkIdPostMerge which clarifies the placement of MergeForkIdTransition
 * hardfork, which by default is post merge as with the merged eth networks but could also come
 * before merge like in kiln genesis
 * @returns genesis parameters in a `CommonOpts` compliant object
 */
function parseGethParams(json, mergeForkIdPostMerge = true) {
    const { name, config, difficulty, mixHash, gasLimit, coinbase, baseFeePerGas, excessBlobGas, } = json;
    let { extraData, timestamp, nonce } = json;
    const genesisTimestamp = Number(timestamp);
    const { chainId } = config;
    // geth is not strictly putting empty fields with a 0x prefix
    if (extraData === '') {
        extraData = '0x';
    }
    // geth may use number for timestamp
    if (!isHexPrefixed(timestamp)) {
        timestamp = intToHex(parseInt(timestamp));
    }
    // geth may not give us a nonce strictly formatted to an 8 byte hex string
    if (nonce.length !== 18) {
        nonce = formatNonce(nonce);
    }
    // EIP155 and EIP158 are both part of Spurious Dragon hardfork and must occur at the same time
    // but have different configuration parameters in geth genesis parameters
    if (config.eip155Block !== config.eip158Block) {
        throw new Error('EIP155 block number must equal EIP 158 block number since both are part of SpuriousDragon hardfork and the client only supports activating the full hardfork');
    }
    const params = {
        name,
        chainId,
        networkId: chainId,
        genesis: {
            timestamp,
            gasLimit,
            difficulty,
            nonce,
            extraData,
            mixHash,
            coinbase,
            baseFeePerGas,
            excessBlobGas,
        },
        hardfork: undefined,
        hardforks: [],
        bootstrapNodes: [],
        consensus: config.clique !== undefined
            ? {
                type: 'poa',
                algorithm: 'clique',
                clique: {
                    // The recent geth genesis seems to be using blockperiodseconds
                    // and epochlength for clique specification
                    // see: https://hackmd.io/PqZgMpnkSWCWv5joJoFymQ
                    period: config.clique.period ?? config.clique.blockperiodseconds,
                    epoch: config.clique.epoch ?? config.clique.epochlength,
                },
            }
            : {
                type: 'pow',
                algorithm: 'ethash',
                ethash: {},
            },
    };
    const forkMap = {
        [Hardfork.Homestead]: { name: 'homesteadBlock' },
        [Hardfork.Dao]: { name: 'daoForkBlock' },
        [Hardfork.TangerineWhistle]: { name: 'eip150Block' },
        [Hardfork.SpuriousDragon]: { name: 'eip155Block' },
        [Hardfork.Byzantium]: { name: 'byzantiumBlock' },
        [Hardfork.Constantinople]: { name: 'constantinopleBlock' },
        [Hardfork.Petersburg]: { name: 'petersburgBlock' },
        [Hardfork.Istanbul]: { name: 'istanbulBlock' },
        [Hardfork.MuirGlacier]: { name: 'muirGlacierBlock' },
        [Hardfork.Berlin]: { name: 'berlinBlock' },
        [Hardfork.London]: { name: 'londonBlock' },
        [Hardfork.MergeForkIdTransition]: { name: 'mergeForkBlock', postMerge: mergeForkIdPostMerge },
        [Hardfork.Shanghai]: { name: 'shanghaiTime', postMerge: true, isTimestamp: true },
        [Hardfork.Cancun]: { name: 'cancunTime', postMerge: true, isTimestamp: true },
        [Hardfork.Prague]: { name: 'pragueTime', postMerge: true, isTimestamp: true },
    };
    // forkMapRev is the map from config field name to Hardfork
    const forkMapRev = Object.keys(forkMap).reduce((acc, elem) => {
        acc[forkMap[elem].name] = elem;
        return acc;
    }, {});
    const configHardforkNames = Object.keys(config).filter((key) => forkMapRev[key] !== undefined && config[key] !== undefined && config[key] !== null);
    params.hardforks = configHardforkNames
        .map((nameBlock) => ({
        name: forkMapRev[nameBlock],
        block: forkMap[forkMapRev[nameBlock]].isTimestamp === true || typeof config[nameBlock] !== 'number'
            ? null
            : config[nameBlock],
        timestamp: forkMap[forkMapRev[nameBlock]].isTimestamp === true && typeof config[nameBlock] === 'number'
            ? config[nameBlock]
            : undefined,
    }))
        .filter((fork) => fork.block !== null || fork.timestamp !== undefined);
    params.hardforks.sort(function (a, b) {
        return (a.block ?? Infinity) - (b.block ?? Infinity);
    });
    params.hardforks.sort(function (a, b) {
        // non timestamp forks come before any timestamp forks
        return (a.timestamp ?? 0) - (b.timestamp ?? 0);
    });
    // only set the genesis timestamp forks to zero post the above sort has happended
    // to get the correct sorting
    for (const hf of params.hardforks) {
        if (hf.timestamp === genesisTimestamp) {
            hf.timestamp = 0;
        }
    }
    if (config.terminalTotalDifficulty !== undefined) {
        // Following points need to be considered for placement of merge hf
        // - Merge hardfork can't be placed at genesis
        // - Place merge hf before any hardforks that require CL participation for e.g. withdrawals
        // - Merge hardfork has to be placed just after genesis if any of the genesis hardforks make CL
        //   necessary for e.g. withdrawals
        const mergeConfig = {
            name: Hardfork.Paris,
            ttd: config.terminalTotalDifficulty,
            block: null,
        };
        // Merge hardfork has to be placed before first hardfork that is dependent on merge
        const postMergeIndex = params.hardforks.findIndex((hf) => forkMap[hf.name]?.postMerge === true);
        if (postMergeIndex !== -1) {
            params.hardforks.splice(postMergeIndex, 0, mergeConfig);
        }
        else {
            params.hardforks.push(mergeConfig);
        }
    }
    const latestHardfork = params.hardforks.length > 0 ? params.hardforks.slice(-1)[0] : undefined;
    params.hardfork = latestHardfork?.name;
    params.hardforks.unshift({ name: Hardfork.Chainstart, block: 0 });
    return params;
}
/**
 * Parses a genesis.json exported from Geth into parameters for Common instance
 * @param json representing the Geth genesis file
 * @param name optional chain name
 * @returns parsed params
 */
function parseGethGenesis(json, name, mergeForkIdPostMerge) {
    try {
        const required = ['config', 'difficulty', 'gasLimit', 'nonce', 'alloc'];
        if (required.some((field) => !(field in json))) {
            const missingField = required.filter((field) => !(field in json));
            throw new Error(`Invalid format, expected geth genesis field "${missingField}" missing`);
        }
        if (name !== undefined) {
            json.name = name;
        }
        return parseGethParams(json, mergeForkIdPostMerge);
    }
    catch (e) {
        throw new Error(`Error parsing parameters file: ${e.message}`);
    }
}

/**
 * Common class to access chain and hardfork parameters and to provide
 * a unified and shared view on the network and hardfork state.
 *
 * Use the {@link Common.custom} static constructor for creating simple
 * custom chain {@link Common} objects (more complete custom chain setups
 * can be created via the main constructor and the {@link CommonOpts.customChains} parameter).
 */
class Common {
    constructor(opts) {
        this._eips = [];
        this._paramsCache = {};
        this._activatedEIPsCache = [];
        this.events = new EventEmitter();
        this._customChains = opts.customChains ?? [];
        this._chainParams = this.setChain(opts.chain);
        this.DEFAULT_HARDFORK = this._chainParams.defaultHardfork ?? Hardfork.Shanghai;
        // Assign hardfork changes in the sequence of the applied hardforks
        this.HARDFORK_CHANGES = this.hardforks().map((hf) => [
            hf.name,
            hardforks[hf.name],
        ]);
        this._hardfork = this.DEFAULT_HARDFORK;
        if (opts.hardfork !== undefined) {
            this.setHardfork(opts.hardfork);
        }
        if (opts.eips) {
            this.setEIPs(opts.eips);
        }
        this.customCrypto = opts.customCrypto ?? {};
        if (Object.keys(this._paramsCache).length === 0) {
            this._buildParamsCache();
            this._buildActivatedEIPsCache();
        }
    }
    /**
     * Creates a {@link Common} object for a custom chain, based on a standard one.
     *
     * It uses all the {@link Chain} parameters from the {@link baseChain} option except the ones overridden
     * in a provided {@link chainParamsOrName} dictionary. Some usage example:
     *
     * ```javascript
     * Common.custom({chainId: 123})
     * ```
     *
     * There are also selected supported custom chains which can be initialized by using one of the
     * {@link CustomChains} for {@link chainParamsOrName}, e.g.:
     *
     * ```javascript
     * Common.custom(CustomChains.MaticMumbai)
     * ```
     *
     * Note that these supported custom chains only provide some base parameters (usually the chain and
     * network ID and a name) and can only be used for selected use cases (e.g. sending a tx with
     * the `@ethereumjs/tx` library to a Layer-2 chain).
     *
     * @param chainParamsOrName Custom parameter dict (`name` will default to `custom-chain`) or string with name of a supported custom chain
     * @param opts Custom chain options to set the {@link CustomCommonOpts.baseChain}, selected {@link CustomCommonOpts.hardfork} and others
     */
    static custom(chainParamsOrName, opts = {}) {
        const baseChain = opts.baseChain ?? 'mainnet';
        const standardChainParams = { ...Common._getChainParams(baseChain) };
        standardChainParams['name'] = 'custom-chain';
        if (typeof chainParamsOrName !== 'string') {
            return new Common({
                chain: {
                    ...standardChainParams,
                    ...chainParamsOrName,
                },
                ...opts,
            });
        }
        else {
            if (chainParamsOrName === CustomChain.PolygonMainnet) {
                return Common.custom({
                    name: CustomChain.PolygonMainnet,
                    chainId: 137,
                    networkId: 137,
                }, opts);
            }
            if (chainParamsOrName === CustomChain.PolygonMumbai) {
                return Common.custom({
                    name: CustomChain.PolygonMumbai,
                    chainId: 80001,
                    networkId: 80001,
                }, opts);
            }
            if (chainParamsOrName === CustomChain.ArbitrumOne) {
                return Common.custom({
                    name: CustomChain.ArbitrumOne,
                    chainId: 42161,
                    networkId: 42161,
                }, opts);
            }
            if (chainParamsOrName === CustomChain.xDaiChain) {
                return Common.custom({
                    name: CustomChain.xDaiChain,
                    chainId: 100,
                    networkId: 100,
                }, opts);
            }
            if (chainParamsOrName === CustomChain.OptimisticKovan) {
                return Common.custom({
                    name: CustomChain.OptimisticKovan,
                    chainId: 69,
                    networkId: 69,
                }, 
                // Optimism has not implemented the London hardfork yet (targeting Q1.22)
                { hardfork: Hardfork.Berlin, ...opts });
            }
            if (chainParamsOrName === CustomChain.OptimisticEthereum) {
                return Common.custom({
                    name: CustomChain.OptimisticEthereum,
                    chainId: 10,
                    networkId: 10,
                }, 
                // Optimism has not implemented the London hardfork yet (targeting Q1.22)
                { hardfork: Hardfork.Berlin, ...opts });
            }
            throw new Error(`Custom chain ${chainParamsOrName} not supported`);
        }
    }
    /**
     * Static method to load and set common from a geth genesis json
     * @param genesisJson json of geth configuration
     * @param { chain, eips, genesisHash, hardfork, mergeForkIdPostMerge } to further configure the common instance
     * @returns Common
     */
    static fromGethGenesis(genesisJson, { chain, eips, genesisHash, hardfork, mergeForkIdPostMerge, customCrypto }) {
        const genesisParams = parseGethGenesis(genesisJson, chain, mergeForkIdPostMerge);
        const common = new Common({
            chain: genesisParams.name ?? 'custom',
            customChains: [genesisParams],
            eips,
            hardfork: hardfork ?? genesisParams.hardfork,
            customCrypto,
        });
        if (genesisHash !== undefined) {
            common.setForkHashes(genesisHash);
        }
        return common;
    }
    /**
     * Static method to determine if a {@link chainId} is supported as a standard chain
     * @param chainId bigint id (`1`) of a standard chain
     * @returns boolean
     */
    static isSupportedChainId(chainId) {
        const initializedChains = this.getInitializedChains();
        return Boolean(initializedChains['names'][chainId.toString()]);
    }
    static _getChainParams(chain, customChains) {
        const initializedChains = this.getInitializedChains(customChains);
        if (typeof chain === 'number' || typeof chain === 'bigint') {
            chain = chain.toString();
            if (initializedChains['names'][chain]) {
                const name = initializedChains['names'][chain];
                return initializedChains[name];
            }
            throw new Error(`Chain with ID ${chain} not supported`);
        }
        if (initializedChains[chain] !== undefined) {
            return initializedChains[chain];
        }
        throw new Error(`Chain with name ${chain} not supported`);
    }
    /**
     * Sets the chain
     * @param chain String ('mainnet') or Number (1) chain representation.
     *              Or, a Dictionary of chain parameters for a private network.
     * @returns The dictionary with parameters set as chain
     */
    setChain(chain) {
        if (typeof chain === 'number' || typeof chain === 'bigint' || typeof chain === 'string') {
            this._chainParams = Common._getChainParams(chain, this._customChains);
        }
        else if (typeof chain === 'object') {
            if (this._customChains.length > 0) {
                throw new Error('Chain must be a string, number, or bigint when initialized with customChains passed in');
            }
            const required = ['networkId', 'genesis', 'hardforks', 'bootstrapNodes'];
            for (const param of required) {
                if (!(param in chain)) {
                    throw new Error(`Missing required chain parameter: ${param}`);
                }
            }
            this._chainParams = chain;
        }
        else {
            throw new Error('Wrong input format');
        }
        for (const hf of this.hardforks()) {
            if (hf.block === undefined) {
                throw new Error(`Hardfork cannot have undefined block number`);
            }
        }
        return this._chainParams;
    }
    /**
     * Sets the hardfork to get params for
     * @param hardfork String identifier (e.g. 'byzantium') or {@link Hardfork} enum
     */
    setHardfork(hardfork) {
        let existing = false;
        for (const hfChanges of this.HARDFORK_CHANGES) {
            if (hfChanges[0] === hardfork) {
                if (this._hardfork !== hardfork) {
                    this._hardfork = hardfork;
                    this._buildParamsCache();
                    this._buildActivatedEIPsCache();
                    this.events.emit('hardforkChanged', hardfork);
                }
                existing = true;
            }
        }
        if (!existing) {
            throw new Error(`Hardfork with name ${hardfork} not supported`);
        }
    }
    /**
     * Returns the hardfork either based on block numer (older HFs) or
     * timestamp (Shanghai upwards).
     *
     * An optional TD takes precedence in case the corresponding HF block
     * is set to `null` or otherwise needs to match (if not an error
     * will be thrown).
     *
     * @param Opts Block number, timestamp or TD (all optional)
     * @returns The name of the HF
     */
    getHardforkBy(opts) {
        let { blockNumber, timestamp, td } = opts;
        blockNumber = toType(blockNumber, TypeOutput.BigInt);
        td = toType(td, TypeOutput.BigInt);
        timestamp = toType(timestamp, TypeOutput.BigInt);
        // Filter out hardforks with no block number, no ttd or no timestamp (i.e. unapplied hardforks)
        const hfs = this.hardforks().filter((hf) => hf.block !== null || (hf.ttd !== null && hf.ttd !== undefined) || hf.timestamp !== undefined);
        const mergeIndex = hfs.findIndex((hf) => hf.ttd !== null && hf.ttd !== undefined);
        const doubleTTDHF = hfs
            .slice(mergeIndex + 1)
            .findIndex((hf) => hf.ttd !== null && hf.ttd !== undefined);
        if (doubleTTDHF >= 0) {
            throw Error(`More than one merge hardforks found with ttd specified`);
        }
        // Find the first hardfork that has a block number greater than `blockNumber`
        // (skips the merge hardfork since it cannot have a block number specified).
        // If timestamp is not provided, it also skips timestamps hardforks to continue
        // discovering/checking number hardforks.
        let hfIndex = hfs.findIndex((hf) => (blockNumber !== undefined &&
            hf.block !== null &&
            BigInt(hf.block) > blockNumber) ||
            (timestamp !== undefined && hf.timestamp !== undefined && hf.timestamp > timestamp));
        if (hfIndex === -1) {
            // all hardforks apply, set hfIndex to the last one as that's the candidate
            hfIndex = hfs.length;
        }
        else if (hfIndex === 0) {
            // cannot have a case where a block number is before all applied hardforks
            // since the chain has to start with a hardfork
            throw Error('Must have at least one hardfork at block 0');
        }
        // If timestamp is not provided, we need to rollback to the last hf with block or ttd
        if (timestamp === undefined) {
            const stepBack = hfs
                .slice(0, hfIndex)
                .reverse()
                .findIndex((hf) => hf.block !== null || hf.ttd !== undefined);
            hfIndex = hfIndex - stepBack;
        }
        // Move hfIndex one back to arrive at candidate hardfork
        hfIndex = hfIndex - 1;
        // If the timestamp was not provided, we could have skipped timestamp hardforks to look for number
        // hardforks. so it will now be needed to rollback
        if (hfs[hfIndex].block === null && hfs[hfIndex].timestamp === undefined) {
            // We're on the merge hardfork.  Let's check the TTD
            if (td === undefined || td === null || BigInt(hfs[hfIndex].ttd) > td) {
                // Merge ttd greater than current td so we're on hardfork before merge
                hfIndex -= 1;
            }
        }
        else {
            if (mergeIndex >= 0 && td !== undefined && td !== null) {
                if (hfIndex >= mergeIndex && BigInt(hfs[mergeIndex].ttd) > td) {
                    throw Error('Maximum HF determined by total difficulty is lower than the block number HF');
                }
                else if (hfIndex < mergeIndex && BigInt(hfs[mergeIndex].ttd) < td) {
                    throw Error('HF determined by block number is lower than the minimum total difficulty HF');
                }
            }
        }
        const hfStartIndex = hfIndex;
        // Move the hfIndex to the end of the hardforks that might be scheduled on the same block/timestamp
        // This won't anyway be the case with Merge hfs
        for (; hfIndex < hfs.length - 1; hfIndex++) {
            // break out if hfIndex + 1 is not scheduled at hfIndex
            if (hfs[hfIndex].block !== hfs[hfIndex + 1].block ||
                hfs[hfIndex].timestamp !== hfs[hfIndex + 1].timestamp) {
                break;
            }
        }
        if (timestamp !== undefined) {
            const minTimeStamp = hfs
                .slice(0, hfStartIndex)
                .reduce((acc, hf) => Math.max(Number(hf.timestamp ?? '0'), acc), 0);
            if (minTimeStamp > timestamp) {
                throw Error(`Maximum HF determined by timestamp is lower than the block number/ttd HF`);
            }
            const maxTimeStamp = hfs
                .slice(hfIndex + 1)
                .reduce((acc, hf) => Math.min(Number(hf.timestamp ?? timestamp), acc), Number(timestamp));
            if (maxTimeStamp < timestamp) {
                throw Error(`Maximum HF determined by block number/ttd is lower than timestamp HF`);
            }
        }
        const hardfork = hfs[hfIndex];
        return hardfork.name;
    }
    /**
     * Sets a new hardfork either based on block numer (older HFs) or
     * timestamp (Shanghai upwards).
     *
     * An optional TD takes precedence in case the corresponding HF block
     * is set to `null` or otherwise needs to match (if not an error
     * will be thrown).
     *
     * @param Opts Block number, timestamp or TD (all optional)
     * @returns The name of the HF set
     */
    setHardforkBy(opts) {
        const hardfork = this.getHardforkBy(opts);
        this.setHardfork(hardfork);
        return hardfork;
    }
    /**
     * Internal helper function, returns the params for the given hardfork for the chain set
     * @param hardfork Hardfork name
     * @returns Dictionary with hardfork params or null if hardfork not on chain
     */
    _getHardfork(hardfork) {
        const hfs = this.hardforks();
        for (const hf of hfs) {
            if (hf['name'] === hardfork)
                return hf;
        }
        return null;
    }
    /**
     * Sets the active EIPs
     * @param eips
     */
    setEIPs(eips = []) {
        for (const eip of eips) {
            if (!(eip in EIPs)) {
                throw new Error(`${eip} not supported`);
            }
            const minHF = this.gteHardfork(EIPs[eip]['minimumHardfork']);
            if (!minHF) {
                throw new Error(`${eip} cannot be activated on hardfork ${this.hardfork()}, minimumHardfork: ${minHF}`);
            }
        }
        this._eips = eips;
        this._buildParamsCache();
        this._buildActivatedEIPsCache();
        for (const eip of eips) {
            if (EIPs[eip].requiredEIPs !== undefined) {
                for (const elem of EIPs[eip].requiredEIPs) {
                    if (!(eips.includes(elem) || this.isActivatedEIP(elem))) {
                        throw new Error(`${eip} requires EIP ${elem}, but is not included in the EIP list`);
                    }
                }
            }
        }
    }
    /**
     * Internal helper for _buildParamsCache()
     */
    _mergeWithParamsCache(params) {
        this._paramsCache['gasConfig'] = {
            ...this._paramsCache['gasConfig'],
            ...params['gasConfig'],
        };
        this._paramsCache['gasPrices'] = {
            ...this._paramsCache['gasPrices'],
            ...params['gasPrices'],
        };
        this._paramsCache['pow'] = {
            ...this._paramsCache['pow'],
            ...params['pow'],
        };
        this._paramsCache['sharding'] = {
            ...this._paramsCache['sharding'],
            ...params['sharding'],
        };
        this._paramsCache['vm'] = {
            ...this._paramsCache['vm'],
            ...params['vm'],
        };
    }
    /**
     * Build up a cache for all parameter values for the current HF and all activated EIPs
     */
    _buildParamsCache() {
        this._paramsCache = {};
        // Iterate through all hardforks up to hardfork set
        const hardfork = this.hardfork();
        for (const hfChanges of this.HARDFORK_CHANGES) {
            // EIP-referencing HF config (e.g. for berlin)
            if ('eips' in hfChanges[1]) {
                const hfEIPs = hfChanges[1]['eips'];
                for (const eip of hfEIPs) {
                    if (!(eip in EIPs)) {
                        throw new Error(`${eip} not supported`);
                    }
                    this._mergeWithParamsCache(EIPs[eip]);
                }
                // Parameter-inlining HF config (e.g. for istanbul)
            }
            else {
                this._mergeWithParamsCache(hfChanges[1]);
            }
            if (hfChanges[0] === hardfork)
                break;
        }
        // Iterate through all additionally activated EIPs
        for (const eip of this._eips) {
            if (!(eip in EIPs)) {
                throw new Error(`${eip} not supported`);
            }
            this._mergeWithParamsCache(EIPs[eip]);
        }
    }
    _buildActivatedEIPsCache() {
        this._activatedEIPsCache = [];
        for (const hfChanges of this.HARDFORK_CHANGES) {
            const hf = hfChanges[1];
            if (this.gteHardfork(hf['name']) && 'eips' in hf) {
                this._activatedEIPsCache = this._activatedEIPsCache.concat(hf['eips']);
            }
        }
        this._activatedEIPsCache = this._activatedEIPsCache.concat(this._eips);
    }
    /**
     * Returns a parameter for the current chain setup
     *
     * If the parameter is present in an EIP, the EIP always takes precedence.
     * Otherwise the parameter is taken from the latest applied HF with
     * a change on the respective parameter.
     *
     * @param topic Parameter topic ('gasConfig', 'gasPrices', 'vm', 'pow')
     * @param name Parameter name (e.g. 'minGasLimit' for 'gasConfig' topic)
     * @returns The value requested or `BigInt(0)` if not found
     */
    param(topic, name) {
        // TODO: consider the case that different active EIPs
        // can change the same parameter
        let value = null;
        if (this._paramsCache[topic] !== undefined &&
            this._paramsCache[topic][name] !== undefined) {
            value = this._paramsCache[topic][name].v;
        }
        return BigInt(value ?? 0);
    }
    /**
     * Returns the parameter corresponding to a hardfork
     * @param topic Parameter topic ('gasConfig', 'gasPrices', 'vm', 'pow')
     * @param name Parameter name (e.g. 'minGasLimit' for 'gasConfig' topic)
     * @param hardfork Hardfork name
     * @returns The value requested or `BigInt(0)` if not found
     */
    paramByHardfork(topic, name, hardfork) {
        let value = null;
        for (const hfChanges of this.HARDFORK_CHANGES) {
            // EIP-referencing HF config (e.g. for berlin)
            if ('eips' in hfChanges[1]) {
                const hfEIPs = hfChanges[1]['eips'];
                for (const eip of hfEIPs) {
                    const valueEIP = this.paramByEIP(topic, name, eip);
                    value = typeof valueEIP === 'bigint' ? valueEIP : value;
                }
                // Parameter-inlining HF config (e.g. for istanbul)
            }
            else {
                if (hfChanges[1][topic] !== undefined &&
                    hfChanges[1][topic][name] !== undefined) {
                    value = hfChanges[1][topic][name].v;
                }
            }
            if (hfChanges[0] === hardfork)
                break;
        }
        return BigInt(value ?? 0);
    }
    /**
     * Returns a parameter corresponding to an EIP
     * @param topic Parameter topic ('gasConfig', 'gasPrices', 'vm', 'pow')
     * @param name Parameter name (e.g. 'minGasLimit' for 'gasConfig' topic)
     * @param eip Number of the EIP
     * @returns The value requested or `undefined` if not found
     */
    paramByEIP(topic, name, eip) {
        if (!(eip in EIPs)) {
            throw new Error(`${eip} not supported`);
        }
        const eipParams = EIPs[eip];
        if (!(topic in eipParams)) {
            return undefined;
        }
        if (eipParams[topic][name] === undefined) {
            return undefined;
        }
        const value = eipParams[topic][name].v;
        return BigInt(value);
    }
    /**
     * Returns a parameter for the hardfork active on block number or
     * optional provided total difficulty (Merge HF)
     * @param topic Parameter topic
     * @param name Parameter name
     * @param blockNumber Block number
     * @param td Total difficulty
     *    * @returns The value requested or `BigInt(0)` if not found
     */
    paramByBlock(topic, name, blockNumber, td, timestamp) {
        const hardfork = this.getHardforkBy({ blockNumber, td, timestamp });
        return this.paramByHardfork(topic, name, hardfork);
    }
    /**
     * Checks if an EIP is activated by either being included in the EIPs
     * manually passed in with the {@link CommonOpts.eips} or in a
     * hardfork currently being active
     *
     * Note: this method only works for EIPs being supported
     * by the {@link CommonOpts.eips} constructor option
     * @param eip
     */
    isActivatedEIP(eip) {
        if (this._activatedEIPsCache.includes(eip)) {
            return true;
        }
        return false;
    }
    /**
     * Checks if set or provided hardfork is active on block number
     * @param hardfork Hardfork name or null (for HF set)
     * @param blockNumber
     * @returns True if HF is active on block number
     */
    hardforkIsActiveOnBlock(hardfork, blockNumber) {
        blockNumber = toType(blockNumber, TypeOutput.BigInt);
        hardfork = hardfork ?? this._hardfork;
        const hfBlock = this.hardforkBlock(hardfork);
        if (typeof hfBlock === 'bigint' && hfBlock !== BIGINT_0 && blockNumber >= hfBlock) {
            return true;
        }
        return false;
    }
    /**
     * Alias to hardforkIsActiveOnBlock when hardfork is set
     * @param blockNumber
     * @returns True if HF is active on block number
     */
    activeOnBlock(blockNumber) {
        return this.hardforkIsActiveOnBlock(null, blockNumber);
    }
    /**
     * Sequence based check if given or set HF1 is greater than or equal HF2
     * @param hardfork1 Hardfork name or null (if set)
     * @param hardfork2 Hardfork name
     * @param opts Hardfork options
     * @returns True if HF1 gte HF2
     */
    hardforkGteHardfork(hardfork1, hardfork2) {
        hardfork1 = hardfork1 ?? this._hardfork;
        const hardforks = this.hardforks();
        let posHf1 = -1, posHf2 = -1;
        let index = 0;
        for (const hf of hardforks) {
            if (hf['name'] === hardfork1)
                posHf1 = index;
            if (hf['name'] === hardfork2)
                posHf2 = index;
            index += 1;
        }
        return posHf1 >= posHf2 && posHf2 !== -1;
    }
    /**
     * Alias to hardforkGteHardfork when hardfork is set
     * @param hardfork Hardfork name
     * @returns True if hardfork set is greater than hardfork provided
     */
    gteHardfork(hardfork) {
        return this.hardforkGteHardfork(null, hardfork);
    }
    /**
     * Returns the hardfork change block for hardfork provided or set
     * @param hardfork Hardfork name, optional if HF set
     * @returns Block number or null if unscheduled
     */
    hardforkBlock(hardfork) {
        hardfork = hardfork ?? this._hardfork;
        const block = this._getHardfork(hardfork)?.['block'];
        if (block === undefined || block === null) {
            return null;
        }
        return BigInt(block);
    }
    hardforkTimestamp(hardfork) {
        hardfork = hardfork ?? this._hardfork;
        const timestamp = this._getHardfork(hardfork)?.['timestamp'];
        if (timestamp === undefined || timestamp === null) {
            return null;
        }
        return BigInt(timestamp);
    }
    /**
     * Returns the hardfork change block for eip
     * @param eip EIP number
     * @returns Block number or null if unscheduled
     */
    eipBlock(eip) {
        for (const hfChanges of this.HARDFORK_CHANGES) {
            const hf = hfChanges[1];
            if ('eips' in hf) {
                // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
                if (hf['eips'].includes(eip)) {
                    return this.hardforkBlock(hfChanges[0]);
                }
            }
        }
        return null;
    }
    /**
     * Returns the hardfork change total difficulty (Merge HF) for hardfork provided or set
     * @param hardfork Hardfork name, optional if HF set
     * @returns Total difficulty or null if no set
     */
    hardforkTTD(hardfork) {
        hardfork = hardfork ?? this._hardfork;
        const ttd = this._getHardfork(hardfork)?.['ttd'];
        if (ttd === undefined || ttd === null) {
            return null;
        }
        return BigInt(ttd);
    }
    /**
     * Returns the change block for the next hardfork after the hardfork provided or set
     * @param hardfork Hardfork name, optional if HF set
     * @returns Block timestamp, number or null if not available
     */
    nextHardforkBlockOrTimestamp(hardfork) {
        hardfork = hardfork ?? this._hardfork;
        const hfs = this.hardforks();
        let hfIndex = hfs.findIndex((hf) => hf.name === hardfork);
        // If the current hardfork is merge, go one behind as merge hf is not part of these
        // calcs even if the merge hf block is set
        if (hardfork === Hardfork.Paris) {
            hfIndex -= 1;
        }
        // Hardfork not found
        if (hfIndex < 0) {
            return null;
        }
        let currHfTimeOrBlock = hfs[hfIndex].timestamp ?? hfs[hfIndex].block;
        currHfTimeOrBlock =
            currHfTimeOrBlock !== null && currHfTimeOrBlock !== undefined
                ? Number(currHfTimeOrBlock)
                : null;
        const nextHf = hfs.slice(hfIndex + 1).find((hf) => {
            let hfTimeOrBlock = hf.timestamp ?? hf.block;
            hfTimeOrBlock =
                hfTimeOrBlock !== null && hfTimeOrBlock !== undefined ? Number(hfTimeOrBlock) : null;
            return (hf.name !== Hardfork.Paris &&
                hfTimeOrBlock !== null &&
                hfTimeOrBlock !== undefined &&
                hfTimeOrBlock !== currHfTimeOrBlock);
        });
        // If no next hf found with valid block or timestamp return null
        if (nextHf === undefined) {
            return null;
        }
        const nextHfBlock = nextHf.timestamp ?? nextHf.block;
        if (nextHfBlock === null || nextHfBlock === undefined) {
            return null;
        }
        return BigInt(nextHfBlock);
    }
    /**
     * Internal helper function to calculate a fork hash
     * @param hardfork Hardfork name
     * @param genesisHash Genesis block hash of the chain
     * @returns Fork hash as hex string
     */
    _calcForkHash(hardfork, genesisHash) {
        let hfBytes = new Uint8Array(0);
        let prevBlockOrTime = 0;
        for (const hf of this.hardforks()) {
            const { block, timestamp, name } = hf;
            // Timestamp to be used for timestamp based hfs even if we may bundle
            // block number with them retrospectively
            let blockOrTime = timestamp ?? block;
            blockOrTime = blockOrTime !== null ? Number(blockOrTime) : null;
            // Skip for chainstart (0), not applied HFs (null) and
            // when already applied on same blockOrTime HFs
            // and on the merge since forkhash doesn't change on merge hf
            if (typeof blockOrTime === 'number' &&
                blockOrTime !== 0 &&
                blockOrTime !== prevBlockOrTime &&
                name !== Hardfork.Paris) {
                const hfBlockBytes = hexToBytes('0x' + blockOrTime.toString(16).padStart(16, '0'));
                hfBytes = concatBytes(hfBytes, hfBlockBytes);
                prevBlockOrTime = blockOrTime;
            }
            if (hf.name === hardfork)
                break;
        }
        const inputBytes = concatBytes(genesisHash, hfBytes);
        // CRC32 delivers result as signed (negative) 32-bit integer,
        // convert to hex string
        const forkhash = bytesToHex(intToBytes(crc32(inputBytes) >>> 0));
        return forkhash;
    }
    /**
     * Returns an eth/64 compliant fork hash (EIP-2124)
     * @param hardfork Hardfork name, optional if HF set
     * @param genesisHash Genesis block hash of the chain, optional if already defined and not needed to be calculated
     */
    forkHash(hardfork, genesisHash) {
        hardfork = hardfork ?? this._hardfork;
        const data = this._getHardfork(hardfork);
        if (data === null ||
            (data?.block === null && data?.timestamp === undefined && data?.ttd === undefined)) {
            const msg = 'No fork hash calculation possible for future hardfork';
            throw new Error(msg);
        }
        if (data?.forkHash !== null && data?.forkHash !== undefined) {
            return data.forkHash;
        }
        if (!genesisHash)
            throw new Error('genesisHash required for forkHash calculation');
        return this._calcForkHash(hardfork, genesisHash);
    }
    /**
     *
     * @param forkHash Fork hash as a hex string
     * @returns Array with hardfork data (name, block, forkHash)
     */
    hardforkForForkHash(forkHash) {
        const resArray = this.hardforks().filter((hf) => {
            return hf.forkHash === forkHash;
        });
        return resArray.length >= 1 ? resArray[resArray.length - 1] : null;
    }
    /**
     * Sets any missing forkHashes on the passed-in {@link Common} instance
     * @param common The {@link Common} to set the forkHashes for
     * @param genesisHash The genesis block hash
     */
    setForkHashes(genesisHash) {
        for (const hf of this.hardforks()) {
            const blockOrTime = hf.timestamp ?? hf.block;
            if ((hf.forkHash === null || hf.forkHash === undefined) &&
                ((blockOrTime !== null && blockOrTime !== undefined) || typeof hf.ttd !== 'undefined')) {
                hf.forkHash = this.forkHash(hf.name, genesisHash);
            }
        }
    }
    /**
     * Returns the Genesis parameters of the current chain
     * @returns Genesis dictionary
     */
    genesis() {
        return this._chainParams.genesis;
    }
    /**
     * Returns the hardforks for current chain
     * @returns {Array} Array with arrays of hardforks
     */
    hardforks() {
        return this._chainParams.hardforks;
    }
    /**
     * Returns bootstrap nodes for the current chain
     * @returns {Dictionary} Dict with bootstrap nodes
     */
    bootstrapNodes() {
        return this._chainParams.bootstrapNodes;
    }
    /**
     * Returns DNS networks for the current chain
     * @returns {String[]} Array of DNS ENR urls
     */
    dnsNetworks() {
        return this._chainParams.dnsNetworks;
    }
    /**
     * Returns the hardfork set
     * @returns Hardfork name
     */
    hardfork() {
        return this._hardfork;
    }
    /**
     * Returns the Id of current chain
     * @returns chain Id
     */
    chainId() {
        return BigInt(this._chainParams.chainId);
    }
    /**
     * Returns the name of current chain
     * @returns chain name (lower case)
     */
    chainName() {
        return this._chainParams.name;
    }
    /**
     * Returns the Id of current network
     * @returns network Id
     */
    networkId() {
        return BigInt(this._chainParams.networkId);
    }
    /**
     * Returns the additionally activated EIPs
     * (by using the `eips` constructor option)
     * @returns List of EIPs
     */
    eips() {
        return this._eips;
    }
    /**
     * Returns the consensus type of the network
     * Possible values: "pow"|"poa"|"pos"
     *
     * Note: This value can update along a Hardfork.
     */
    consensusType() {
        const hardfork = this.hardfork();
        let value;
        for (const hfChanges of this.HARDFORK_CHANGES) {
            if ('consensus' in hfChanges[1]) {
                value = hfChanges[1]['consensus']['type'];
            }
            if (hfChanges[0] === hardfork)
                break;
        }
        return value ?? this._chainParams['consensus']['type'];
    }
    /**
     * Returns the concrete consensus implementation
     * algorithm or protocol for the network
     * e.g. "ethash" for "pow" consensus type,
     * "clique" for "poa" consensus type or
     * "casper" for "pos" consensus type.
     *
     * Note: This value can update along a Hardfork.
     */
    consensusAlgorithm() {
        const hardfork = this.hardfork();
        let value;
        for (const hfChanges of this.HARDFORK_CHANGES) {
            if ('consensus' in hfChanges[1]) {
                value = hfChanges[1]['consensus']['algorithm'];
            }
            if (hfChanges[0] === hardfork)
                break;
        }
        return value ?? this._chainParams['consensus']['algorithm'];
    }
    /**
     * Returns a dictionary with consensus configuration
     * parameters based on the consensus algorithm
     *
     * Expected returns (parameters must be present in
     * the respective chain json files):
     *
     * ethash: empty object
     * clique: period, epoch
     * casper: empty object
     *
     * Note: This value can update along a Hardfork.
     */
    consensusConfig() {
        const hardfork = this.hardfork();
        let value;
        for (const hfChanges of this.HARDFORK_CHANGES) {
            if ('consensus' in hfChanges[1]) {
                // The config parameter is named after the respective consensus algorithm
                const config = hfChanges[1];
                const algorithm = config['consensus']['algorithm'];
                value = config['consensus'][algorithm];
            }
            if (hfChanges[0] === hardfork)
                break;
        }
        return (value ?? this._chainParams['consensus'][this.consensusAlgorithm()] ?? {});
    }
    /**
     * Returns a deep copy of this {@link Common} instance.
     */
    copy() {
        const copy = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
        copy.events = new EventEmitter();
        return copy;
    }
    static getInitializedChains(customChains) {
        const names = {};
        for (const [name, id] of Object.entries(Chain)) {
            names[id] = name.toLowerCase();
        }
        const chains$1 = { ...chains };
        if (customChains) {
            for (const chain of customChains) {
                const { name } = chain;
                names[chain.chainId.toString()] = name;
                chains$1[name] = chain;
            }
        }
        chains$1.names = names;
        return chains$1;
    }
}

/**
 * Can be used in conjunction with {@link Transaction[TransactionType].supports}
 * to query on tx capabilities
 */
var Capability;
(function (Capability) {
    /**
     * Tx supports EIP-155 replay protection
     * See: [155](https://eips.ethereum.org/EIPS/eip-155) Replay Attack Protection EIP
     */
    Capability[Capability["EIP155ReplayProtection"] = 155] = "EIP155ReplayProtection";
    /**
     * Tx supports EIP-1559 gas fee market mechanism
     * See: [1559](https://eips.ethereum.org/EIPS/eip-1559) Fee Market EIP
     */
    Capability[Capability["EIP1559FeeMarket"] = 1559] = "EIP1559FeeMarket";
    /**
     * Tx is a typed transaction as defined in EIP-2718
     * See: [2718](https://eips.ethereum.org/EIPS/eip-2718) Transaction Type EIP
     */
    Capability[Capability["EIP2718TypedTransaction"] = 2718] = "EIP2718TypedTransaction";
    /**
     * Tx supports access list generation as defined in EIP-2930
     * See: [2930](https://eips.ethereum.org/EIPS/eip-2930) Access Lists EIP
     */
    Capability[Capability["EIP2930AccessLists"] = 2930] = "EIP2930AccessLists";
})(Capability || (Capability = {}));
function isAccessListBytes(input) {
    if (input.length === 0) {
        return true;
    }
    const firstItem = input[0];
    if (Array.isArray(firstItem)) {
        return true;
    }
    return false;
}
function isAccessList(input) {
    return !isAccessListBytes(input); // This is exactly the same method, except the output is negated.
}
/**
 * Encompassing type for all transaction types.
 */
var TransactionType;
(function (TransactionType) {
    TransactionType[TransactionType["Legacy"] = 0] = "Legacy";
    TransactionType[TransactionType["AccessListEIP2930"] = 1] = "AccessListEIP2930";
    TransactionType[TransactionType["FeeMarketEIP1559"] = 2] = "FeeMarketEIP1559";
    TransactionType[TransactionType["BlobEIP4844"] = 3] = "BlobEIP4844";
})(TransactionType || (TransactionType = {}));

function checkMaxInitCodeSize(common, length) {
    const maxInitCodeSize = common.param('vm', 'maxInitCodeSize');
    if (maxInitCodeSize && BigInt(length) > maxInitCodeSize) {
        throw new Error(`the initcode size of this transaction is too large: it is ${length} while the max is ${common.param('vm', 'maxInitCodeSize')}`);
    }
}
class AccessLists {
    static getAccessListData(accessList) {
        let AccessListJSON;
        let bufferAccessList;
        if (isAccessList(accessList)) {
            AccessListJSON = accessList;
            const newAccessList = [];
            for (let i = 0; i < accessList.length; i++) {
                const item = accessList[i];
                const addressBytes = hexToBytes(item.address);
                const storageItems = [];
                for (let index = 0; index < item.storageKeys.length; index++) {
                    storageItems.push(hexToBytes(item.storageKeys[index]));
                }
                newAccessList.push([addressBytes, storageItems]);
            }
            bufferAccessList = newAccessList;
        }
        else {
            bufferAccessList = accessList ?? [];
            // build the JSON
            const json = [];
            for (let i = 0; i < bufferAccessList.length; i++) {
                const data = bufferAccessList[i];
                const address = bytesToHex(data[0]);
                const storageKeys = [];
                for (let item = 0; item < data[1].length; item++) {
                    storageKeys.push(bytesToHex(data[1][item]));
                }
                const jsonItem = {
                    address,
                    storageKeys,
                };
                json.push(jsonItem);
            }
            AccessListJSON = json;
        }
        return {
            AccessListJSON,
            accessList: bufferAccessList,
        };
    }
    static verifyAccessList(accessList) {
        for (let key = 0; key < accessList.length; key++) {
            const accessListItem = accessList[key];
            const address = accessListItem[0];
            const storageSlots = accessListItem[1];
            if (accessListItem[2] !== undefined) {
                throw new Error('Access list item cannot have 3 elements. It can only have an address, and an array of storage slots.');
            }
            if (address.length !== 20) {
                throw new Error('Invalid EIP-2930 transaction: address length should be 20 bytes');
            }
            for (let storageSlot = 0; storageSlot < storageSlots.length; storageSlot++) {
                if (storageSlots[storageSlot].length !== 32) {
                    throw new Error('Invalid EIP-2930 transaction: storage slot length should be 32 bytes');
                }
            }
        }
    }
    static getAccessListJSON(accessList) {
        const accessListJSON = [];
        for (let index = 0; index < accessList.length; index++) {
            const item = accessList[index];
            const JSONItem = {
                address: bytesToHex(setLengthLeft(item[0], 20)),
                storageKeys: [],
            };
            const storageSlots = item[1];
            for (let slot = 0; slot < storageSlots.length; slot++) {
                const storageSlot = storageSlots[slot];
                JSONItem.storageKeys.push(bytesToHex(setLengthLeft(storageSlot, 32)));
            }
            accessListJSON.push(JSONItem);
        }
        return accessListJSON;
    }
    static getDataFeeEIP2930(accessList, common) {
        const accessListStorageKeyCost = common.param('gasPrices', 'accessListStorageKeyCost');
        const accessListAddressCost = common.param('gasPrices', 'accessListAddressCost');
        let slots = 0;
        for (let index = 0; index < accessList.length; index++) {
            const item = accessList[index];
            const storageSlots = item[1];
            slots += storageSlots.length;
        }
        const addresses = accessList.length;
        return addresses * Number(accessListAddressCost) + slots * Number(accessListStorageKeyCost);
    }
}
function txTypeBytes(txType) {
    return hexToBytes('0x' + txType.toString(16).padStart(2, '0'));
}

/**
 * This base class will likely be subject to further
 * refactoring along the introduction of additional tx types
 * on the Ethereum network.
 *
 * It is therefore not recommended to use directly.
 */
class BaseTransaction {
    constructor(txData, opts) {
        this.cache = {
            hash: undefined,
            dataFee: undefined,
            senderPubKey: undefined,
        };
        /**
         * List of tx type defining EIPs,
         * e.g. 1559 (fee market) and 2930 (access lists)
         * for FeeMarketEIP1559Transaction objects
         */
        this.activeCapabilities = [];
        /**
         * The default chain the tx falls back to if no Common
         * is provided and if the chain can't be derived from
         * a passed in chainId (only EIP-2718 typed txs) or
         * EIP-155 signature (legacy txs).
         *
         * @hidden
         */
        this.DEFAULT_CHAIN = Chain.Mainnet;
        const { nonce, gasLimit, to, value, data, v, r, s, type } = txData;
        this._type = Number(bytesToBigInt(toBytes(type)));
        this.txOptions = opts;
        const toB = toBytes(to === '' ? '0x' : to);
        const vB = toBytes(v === '' ? '0x' : v);
        const rB = toBytes(r === '' ? '0x' : r);
        const sB = toBytes(s === '' ? '0x' : s);
        this.nonce = bytesToBigInt(toBytes(nonce === '' ? '0x' : nonce));
        this.gasLimit = bytesToBigInt(toBytes(gasLimit === '' ? '0x' : gasLimit));
        this.to = toB.length > 0 ? new Address(toB) : undefined;
        this.value = bytesToBigInt(toBytes(value === '' ? '0x' : value));
        this.data = toBytes(data === '' ? '0x' : data);
        this.v = vB.length > 0 ? bytesToBigInt(vB) : undefined;
        this.r = rB.length > 0 ? bytesToBigInt(rB) : undefined;
        this.s = sB.length > 0 ? bytesToBigInt(sB) : undefined;
        this._validateCannotExceedMaxInteger({ value: this.value, r: this.r, s: this.s });
        // geth limits gasLimit to 2^64-1
        this._validateCannotExceedMaxInteger({ gasLimit: this.gasLimit }, 64);
        // EIP-2681 limits nonce to 2^64-1 (cannot equal 2^64-1)
        this._validateCannotExceedMaxInteger({ nonce: this.nonce }, 64, true);
        const createContract = this.to === undefined || this.to === null;
        const allowUnlimitedInitCodeSize = opts.allowUnlimitedInitCodeSize ?? false;
        const common = opts.common ?? this._getCommon();
        if (createContract && common.isActivatedEIP(3860) && allowUnlimitedInitCodeSize === false) {
            checkMaxInitCodeSize(common, this.data.length);
        }
    }
    /**
     * Returns the transaction type.
     *
     * Note: legacy txs will return tx type `0`.
     */
    get type() {
        return this._type;
    }
    /**
     * Checks if a tx type defining capability is active
     * on a tx, for example the EIP-1559 fee market mechanism
     * or the EIP-2930 access list feature.
     *
     * Note that this is different from the tx type itself,
     * so EIP-2930 access lists can very well be active
     * on an EIP-1559 tx for example.
     *
     * This method can be useful for feature checks if the
     * tx type is unknown (e.g. when instantiated with
     * the tx factory).
     *
     * See `Capabilities` in the `types` module for a reference
     * on all supported capabilities.
     */
    supports(capability) {
        return this.activeCapabilities.includes(capability);
    }
    /**
     * Validates the transaction signature and minimum gas requirements.
     * @returns {string[]} an array of error strings
     */
    getValidationErrors() {
        const errors = [];
        if (this.isSigned() && !this.verifySignature()) {
            errors.push('Invalid Signature');
        }
        if (this.getBaseFee() > this.gasLimit) {
            errors.push(`gasLimit is too low. given ${this.gasLimit}, need at least ${this.getBaseFee()}`);
        }
        return errors;
    }
    /**
     * Validates the transaction signature and minimum gas requirements.
     * @returns {boolean} true if the transaction is valid, false otherwise
     */
    isValid() {
        const errors = this.getValidationErrors();
        return errors.length === 0;
    }
    /**
     * The minimum amount of gas the tx must have (DataFee + TxFee + Creation Fee)
     */
    getBaseFee() {
        const txFee = this.common.param('gasPrices', 'tx');
        let fee = this.getDataFee();
        if (txFee)
            fee += txFee;
        if (this.common.gteHardfork('homestead') && this.toCreationAddress()) {
            const txCreationFee = this.common.param('gasPrices', 'txCreation');
            if (txCreationFee)
                fee += txCreationFee;
        }
        return fee;
    }
    /**
     * The amount of gas paid for the data in this tx
     */
    getDataFee() {
        const txDataZero = this.common.param('gasPrices', 'txDataZero');
        const txDataNonZero = this.common.param('gasPrices', 'txDataNonZero');
        let cost = BIGINT_0;
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] === 0 ? (cost += txDataZero) : (cost += txDataNonZero);
        }
        if ((this.to === undefined || this.to === null) && this.common.isActivatedEIP(3860)) {
            const dataLength = BigInt(Math.ceil(this.data.length / 32));
            const initCodeCost = this.common.param('gasPrices', 'initCodeWordCost') * dataLength;
            cost += initCodeCost;
        }
        return cost;
    }
    /**
     * If the tx's `to` is to the creation address
     */
    toCreationAddress() {
        return this.to === undefined || this.to.bytes.length === 0;
    }
    isSigned() {
        const { v, r, s } = this;
        if (v === undefined || r === undefined || s === undefined) {
            return false;
        }
        else {
            return true;
        }
    }
    /**
     * Determines if the signature is valid
     */
    verifySignature() {
        try {
            // Main signature verification is done in `getSenderPublicKey()`
            const publicKey = this.getSenderPublicKey();
            return unpadBytes(publicKey).length !== 0;
        }
        catch (e) {
            return false;
        }
    }
    /**
     * Returns the sender's address
     */
    getSenderAddress() {
        return new Address(publicToAddress(this.getSenderPublicKey()));
    }
    /**
     * Signs a transaction.
     *
     * Note that the signed tx is returned as a new object,
     * use as follows:
     * ```javascript
     * const signedTx = tx.sign(privateKey)
     * ```
     */
    sign(privateKey) {
        if (privateKey.length !== 32) {
            const msg = this._errorMsg('Private key must be 32 bytes in length.');
            throw new Error(msg);
        }
        // Hack for the constellation that we have got a legacy tx after spuriousDragon with a non-EIP155 conforming signature
        // and want to recreate a signature (where EIP155 should be applied)
        // Leaving this hack lets the legacy.spec.ts -> sign(), verifySignature() test fail
        // 2021-06-23
        let hackApplied = false;
        if (this.type === TransactionType.Legacy &&
            this.common.gteHardfork('spuriousDragon') &&
            !this.supports(Capability.EIP155ReplayProtection)) {
            this.activeCapabilities.push(Capability.EIP155ReplayProtection);
            hackApplied = true;
        }
        const msgHash = this.getHashedMessageToSign();
        const ecSignFunction = this.common.customCrypto?.ecsign ?? ecsign;
        const { v, r, s } = ecSignFunction(msgHash, privateKey);
        const tx = this.addSignature(v, r, s, true);
        // Hack part 2
        if (hackApplied) {
            const index = this.activeCapabilities.indexOf(Capability.EIP155ReplayProtection);
            if (index > -1) {
                this.activeCapabilities.splice(index, 1);
            }
        }
        return tx;
    }
    /**
     * Returns an object with the JSON representation of the transaction
     */
    toJSON() {
        return {
            type: bigIntToHex(BigInt(this.type)),
            nonce: bigIntToHex(this.nonce),
            gasLimit: bigIntToHex(this.gasLimit),
            to: this.to !== undefined ? this.to.toString() : undefined,
            value: bigIntToHex(this.value),
            data: bytesToHex(this.data),
            v: this.v !== undefined ? bigIntToHex(this.v) : undefined,
            r: this.r !== undefined ? bigIntToHex(this.r) : undefined,
            s: this.s !== undefined ? bigIntToHex(this.s) : undefined,
        };
    }
    /**
     * Does chain ID checks on common and returns a common
     * to be used on instantiation
     * @hidden
     *
     * @param common - {@link Common} instance from tx options
     * @param chainId - Chain ID from tx options (typed txs) or signature (legacy tx)
     */
    _getCommon(common, chainId) {
        // Chain ID provided
        if (chainId !== undefined) {
            const chainIdBigInt = bytesToBigInt(toBytes(chainId));
            if (common) {
                if (common.chainId() !== chainIdBigInt) {
                    const msg = this._errorMsg(`The chain ID does not match the chain ID of Common. Got: ${chainIdBigInt}, expected: ${common.chainId}`);
                    throw new Error(msg);
                }
                // Common provided, chain ID does match
                // -> Return provided Common
                return common.copy();
            }
            else {
                if (Common.isSupportedChainId(chainIdBigInt)) {
                    // No Common, chain ID supported by Common
                    // -> Instantiate Common with chain ID
                    return new Common({ chain: chainIdBigInt });
                }
                else {
                    // No Common, chain ID not supported by Common
                    // -> Instantiate custom Common derived from DEFAULT_CHAIN
                    return Common.custom({
                        name: 'custom-chain',
                        networkId: chainIdBigInt,
                        chainId: chainIdBigInt,
                    }, { baseChain: this.DEFAULT_CHAIN });
                }
            }
        }
        else {
            // No chain ID provided
            // -> return Common provided or create new default Common
            return common?.copy() ?? new Common({ chain: this.DEFAULT_CHAIN });
        }
    }
    /**
     * Validates that an object with BigInt values cannot exceed the specified bit limit.
     * @param values Object containing string keys and BigInt values
     * @param bits Number of bits to check (64 or 256)
     * @param cannotEqual Pass true if the number also cannot equal one less the maximum value
     */
    _validateCannotExceedMaxInteger(values, bits = 256, cannotEqual = false) {
        for (const [key, value] of Object.entries(values)) {
            switch (bits) {
                case 64:
                    if (cannotEqual) {
                        if (value !== undefined && value >= MAX_UINT64) {
                            const msg = this._errorMsg(`${key} cannot equal or exceed MAX_UINT64 (2^64-1), given ${value}`);
                            throw new Error(msg);
                        }
                    }
                    else {
                        if (value !== undefined && value > MAX_UINT64) {
                            const msg = this._errorMsg(`${key} cannot exceed MAX_UINT64 (2^64-1), given ${value}`);
                            throw new Error(msg);
                        }
                    }
                    break;
                case 256:
                    if (cannotEqual) {
                        if (value !== undefined && value >= MAX_INTEGER) {
                            const msg = this._errorMsg(`${key} cannot equal or exceed MAX_INTEGER (2^256-1), given ${value}`);
                            throw new Error(msg);
                        }
                    }
                    else {
                        if (value !== undefined && value > MAX_INTEGER) {
                            const msg = this._errorMsg(`${key} cannot exceed MAX_INTEGER (2^256-1), given ${value}`);
                            throw new Error(msg);
                        }
                    }
                    break;
                default: {
                    const msg = this._errorMsg('unimplemented bits value');
                    throw new Error(msg);
                }
            }
        }
    }
    static _validateNotArray(values) {
        const txDataKeys = [
            'nonce',
            'gasPrice',
            'gasLimit',
            'to',
            'value',
            'data',
            'v',
            'r',
            's',
            'type',
            'baseFee',
            'maxFeePerGas',
            'chainId',
        ];
        for (const [key, value] of Object.entries(values)) {
            if (txDataKeys.includes(key)) {
                if (Array.isArray(value)) {
                    throw new Error(`${key} cannot be an array`);
                }
            }
        }
    }
    /**
     * Returns the shared error postfix part for _error() method
     * tx type implementations.
     */
    _getSharedErrorPostfix() {
        let hash = '';
        try {
            hash = this.isSigned() ? bytesToHex(this.hash()) : 'not available (unsigned)';
        }
        catch (e) {
            hash = 'error';
        }
        let isSigned = '';
        try {
            isSigned = this.isSigned().toString();
        }
        catch (e) {
            hash = 'error';
        }
        let hf = '';
        try {
            hf = this.common.hardfork();
        }
        catch (e) {
            hf = 'error';
        }
        let postfix = `tx type=${this.type} hash=${hash} nonce=${this.nonce} value=${this.value} `;
        postfix += `signed=${isSigned} hf=${hf}`;
        return postfix;
    }
}

function getUpfrontCost(tx, baseFee) {
    const prio = tx.maxPriorityFeePerGas;
    const maxBase = tx.maxFeePerGas - baseFee;
    const inclusionFeePerGas = prio < maxBase ? prio : maxBase;
    const gasPrice = inclusionFeePerGas + baseFee;
    return tx.gasLimit * gasPrice + tx.value;
}

function errorMsg(tx, msg) {
    return `${msg} (${tx.errorStr()})`;
}
/**
 * The amount of gas paid for the data in this tx
 */
function getDataFee$1(tx, extraCost) {
    if (tx.cache.dataFee && tx.cache.dataFee.hardfork === tx.common.hardfork()) {
        return tx.cache.dataFee.value;
    }
    const cost = BaseTransaction.prototype.getDataFee.bind(tx)() + (extraCost ?? 0n);
    if (Object.isFrozen(tx)) {
        tx.cache.dataFee = {
            value: cost,
            hardfork: tx.common.hardfork(),
        };
    }
    return cost;
}
function hash(tx) {
    if (!tx.isSigned()) {
        const msg = errorMsg(tx, 'Cannot call hash method if transaction is not signed');
        throw new Error(msg);
    }
    const keccakFunction = tx.common.customCrypto.keccak256 ?? keccak256;
    if (Object.isFrozen(tx)) {
        if (!tx.cache.hash) {
            tx.cache.hash = keccakFunction(tx.serialize());
        }
        return tx.cache.hash;
    }
    return keccakFunction(tx.serialize());
}
/**
 * EIP-2: All transaction signatures whose s-value is greater than secp256k1n/2are considered invalid.
 * Reasoning: https://ethereum.stackexchange.com/a/55728
 */
function validateHighS(tx) {
    const { s } = tx;
    if (tx.common.gteHardfork('homestead') && s !== undefined && s > SECP256K1_ORDER_DIV_2) {
        const msg = errorMsg(tx, 'Invalid Signature: s-values greater than secp256k1n/2 are considered invalid');
        throw new Error(msg);
    }
}
function getSenderPublicKey(tx) {
    if (tx.cache.senderPubKey !== undefined) {
        return tx.cache.senderPubKey;
    }
    const msgHash = tx.getMessageToVerifySignature();
    const { v, r, s } = tx;
    validateHighS(tx);
    try {
        const ecrecoverFunction = tx.common.customCrypto.ecrecover ?? ecrecover;
        const sender = ecrecoverFunction(msgHash, v, bigIntToUnpaddedBytes(r), bigIntToUnpaddedBytes(s), tx.supports(Capability.EIP155ReplayProtection) ? tx.common.chainId() : undefined);
        if (Object.isFrozen(tx)) {
            tx.cache.senderPubKey = sender;
        }
        return sender;
    }
    catch (e) {
        const msg = errorMsg(tx, 'Invalid Signature');
        throw new Error(msg);
    }
}

function getHashedMessageToSign(tx) {
    const keccakFunction = tx.common.customCrypto.keccak256 ?? keccak256;
    return keccakFunction(tx.getMessageToSign());
}
function serialize(tx, base) {
    return concatBytes(txTypeBytes(tx.type), RLP.encode(base ?? tx.raw()));
}
function validateYParity(tx) {
    const { v } = tx;
    if (v !== undefined && v !== BIGINT_0 && v !== BIGINT_1) {
        const msg = errorMsg(tx, 'The y-parity of the transaction should either be 0 or 1');
        throw new Error(msg);
    }
}

/**
 * The amount of gas paid for the data in this tx
 */
function getDataFee(tx) {
    return getDataFee$1(tx, BigInt(AccessLists.getDataFeeEIP2930(tx.accessList, tx.common)));
}

/** EIP4844 constants */
const LIMIT_BLOBS_PER_TX = 6; // 786432 / 2^17 (`MAX_BLOB_GAS_PER_BLOCK` / `GAS_PER_BLOB`)

const validateBlobTransactionNetworkWrapper = (blobVersionedHashes, blobs, commitments, kzgProofs, version, kzg) => {
    if (!(blobVersionedHashes.length === blobs.length && blobs.length === commitments.length)) {
        throw new Error('Number of blobVersionedHashes, blobs, and commitments not all equal');
    }
    if (blobVersionedHashes.length === 0) {
        throw new Error('Invalid transaction with empty blobs');
    }
    let isValid;
    try {
        isValid = kzg.verifyBlobKzgProofBatch(blobs, commitments, kzgProofs);
    }
    catch (error) {
        throw new Error(`KZG verification of blobs fail with error=${error}`);
    }
    if (!isValid) {
        throw new Error('KZG proof cannot be verified from blobs/commitments');
    }
    for (let x = 0; x < blobVersionedHashes.length; x++) {
        const computedVersionedHash = computeVersionedHash$1(commitments[x], version);
        if (!equalsBytes(computedVersionedHash, blobVersionedHashes[x])) {
            throw new Error(`commitment for blob at index ${x} does not match versionedHash`);
        }
    }
};
/**
 * Typed transaction with a new gas fee market mechanism for transactions that include "blobs" of data
 *
 * - TransactionType: 3
 * - EIP: [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844)
 */
class BlobEIP4844Transaction extends BaseTransaction {
    /**
     * This constructor takes the values, validates them, assigns them and freezes the object.
     *
     * It is not recommended to use this constructor directly. Instead use
     * the static constructors or factory methods to assist in creating a Transaction object from
     * varying data types.
     */
    constructor(txData, opts = {}) {
        super({ ...txData, type: TransactionType.BlobEIP4844 }, opts);
        const { chainId, accessList, maxFeePerGas, maxPriorityFeePerGas, maxFeePerBlobGas } = txData;
        this.common = this._getCommon(opts.common, chainId);
        this.chainId = this.common.chainId();
        if (this.common.isActivatedEIP(1559) === false) {
            throw new Error('EIP-1559 not enabled on Common');
        }
        if (this.common.isActivatedEIP(4844) === false) {
            throw new Error('EIP-4844 not enabled on Common');
        }
        this.activeCapabilities = this.activeCapabilities.concat([1559, 2718, 2930]);
        // Populate the access list fields
        const accessListData = AccessLists.getAccessListData(accessList ?? []);
        this.accessList = accessListData.accessList;
        this.AccessListJSON = accessListData.AccessListJSON;
        // Verify the access list format.
        AccessLists.verifyAccessList(this.accessList);
        this.maxFeePerGas = bytesToBigInt(toBytes(maxFeePerGas === '' ? '0x' : maxFeePerGas));
        this.maxPriorityFeePerGas = bytesToBigInt(toBytes(maxPriorityFeePerGas === '' ? '0x' : maxPriorityFeePerGas));
        this._validateCannotExceedMaxInteger({
            maxFeePerGas: this.maxFeePerGas,
            maxPriorityFeePerGas: this.maxPriorityFeePerGas,
        });
        BaseTransaction._validateNotArray(txData);
        if (this.gasLimit * this.maxFeePerGas > MAX_INTEGER) {
            const msg = this._errorMsg('gasLimit * maxFeePerGas cannot exceed MAX_INTEGER (2^256-1)');
            throw new Error(msg);
        }
        if (this.maxFeePerGas < this.maxPriorityFeePerGas) {
            const msg = this._errorMsg('maxFeePerGas cannot be less than maxPriorityFeePerGas (The total must be the larger of the two)');
            throw new Error(msg);
        }
        this.maxFeePerBlobGas = bytesToBigInt(toBytes((maxFeePerBlobGas ?? '') === '' ? '0x' : maxFeePerBlobGas));
        this.blobVersionedHashes = (txData.blobVersionedHashes ?? []).map((vh) => toBytes(vh));
        validateYParity(this);
        validateHighS(this);
        for (const hash of this.blobVersionedHashes) {
            if (hash.length !== 32) {
                const msg = this._errorMsg('versioned hash is invalid length');
                throw new Error(msg);
            }
            if (BigInt(hash[0]) !== this.common.param('sharding', 'blobCommitmentVersionKzg')) {
                const msg = this._errorMsg('versioned hash does not start with KZG commitment version');
                throw new Error(msg);
            }
        }
        if (this.blobVersionedHashes.length > LIMIT_BLOBS_PER_TX) {
            const msg = this._errorMsg(`tx can contain at most ${LIMIT_BLOBS_PER_TX} blobs`);
            throw new Error(msg);
        }
        else if (this.blobVersionedHashes.length === 0) {
            const msg = this._errorMsg(`tx should contain at least one blob`);
            throw new Error(msg);
        }
        if (this.to === undefined) {
            const msg = this._errorMsg(`tx should have a "to" field and cannot be used to create contracts`);
            throw new Error(msg);
        }
        this.blobs = txData.blobs?.map((blob) => toBytes(blob));
        this.kzgCommitments = txData.kzgCommitments?.map((commitment) => toBytes(commitment));
        this.kzgProofs = txData.kzgProofs?.map((proof) => toBytes(proof));
        const freeze = opts?.freeze ?? true;
        if (freeze) {
            Object.freeze(this);
        }
    }
    static fromTxData(txData, opts) {
        if (txData.blobsData !== undefined) {
            if (txData.blobs !== undefined) {
                throw new Error('cannot have both raw blobs data and encoded blobs in constructor');
            }
            if (txData.kzgCommitments !== undefined) {
                throw new Error('cannot have both raw blobs data and KZG commitments in constructor');
            }
            if (txData.blobVersionedHashes !== undefined) {
                throw new Error('cannot have both raw blobs data and versioned hashes in constructor');
            }
            if (txData.kzgProofs !== undefined) {
                throw new Error('cannot have both raw blobs data and KZG proofs in constructor');
            }
            txData.blobs = getBlobs(txData.blobsData.reduce((acc, cur) => acc + cur));
            txData.kzgCommitments = blobsToCommitments(txData.blobs);
            txData.blobVersionedHashes = commitmentsToVersionedHashes$1(txData.kzgCommitments);
            txData.kzgProofs = blobsToProofs(txData.blobs, txData.kzgCommitments);
        }
        return new BlobEIP4844Transaction(txData, opts);
    }
    /**
     * Creates the minimal representation of a blob transaction from the network wrapper version.
     * The minimal representation is used when adding transactions to an execution payload/block
     * @param txData a {@link BlobEIP4844Transaction} containing optional blobs/kzg commitments
     * @param opts - dictionary of {@link TxOptions}
     * @returns the "minimal" representation of a BlobEIP4844Transaction (i.e. transaction object minus blobs and kzg commitments)
     */
    static minimalFromNetworkWrapper(txData, opts) {
        if (opts?.common?.customCrypto?.kzg === undefined) {
            throw new Error('kzg instance required to instantiate blob tx');
        }
        const tx = BlobEIP4844Transaction.fromTxData({
            ...txData,
            ...{ blobs: undefined, kzgCommitments: undefined, kzgProofs: undefined },
        }, opts);
        return tx;
    }
    /**
     * Instantiate a transaction from the serialized tx.
     *
     * Format: `0x03 || rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data,
     * access_list, max_fee_per_data_gas, blob_versioned_hashes, y_parity, r, s])`
     */
    static fromSerializedTx(serialized, opts = {}) {
        if (opts.common?.customCrypto?.kzg === undefined) {
            throw new Error('kzg instance required to instantiate blob tx');
        }
        if (equalsBytes(serialized.subarray(0, 1), txTypeBytes(TransactionType.BlobEIP4844)) === false) {
            throw new Error(`Invalid serialized tx input: not an EIP-4844 transaction (wrong tx type, expected: ${TransactionType.BlobEIP4844}, received: ${bytesToHex(serialized.subarray(0, 1))}`);
        }
        const values = RLP.decode(serialized.subarray(1));
        if (!Array.isArray(values)) {
            throw new Error('Invalid serialized tx input: must be array');
        }
        return BlobEIP4844Transaction.fromValuesArray(values, opts);
    }
    /**
     * Create a transaction from a values array.
     *
     * Format: `[chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data,
     * accessList, signatureYParity, signatureR, signatureS]`
     */
    static fromValuesArray(values, opts = {}) {
        if (opts.common?.customCrypto?.kzg === undefined) {
            throw new Error('kzg instance required to instantiate blob tx');
        }
        if (values.length !== 11 && values.length !== 14) {
            throw new Error('Invalid EIP-4844 transaction. Only expecting 11 values (for unsigned tx) or 14 values (for signed tx).');
        }
        const [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, maxFeePerBlobGas, blobVersionedHashes, v, r, s,] = values;
        this._validateNotArray({ chainId, v });
        validateNoLeadingZeroes({
            nonce,
            maxPriorityFeePerGas,
            maxFeePerGas,
            gasLimit,
            value,
            maxFeePerBlobGas,
            v,
            r,
            s,
        });
        return new BlobEIP4844Transaction({
            chainId: bytesToBigInt(chainId),
            nonce,
            maxPriorityFeePerGas,
            maxFeePerGas,
            gasLimit,
            to,
            value,
            data,
            accessList: accessList ?? [],
            maxFeePerBlobGas,
            blobVersionedHashes,
            v: v !== undefined ? bytesToBigInt(v) : undefined,
            r,
            s,
        }, opts);
    }
    /**
     * Creates a transaction from the network encoding of a blob transaction (with blobs/commitments/proof)
     * @param serialized a buffer representing a serialized BlobTransactionNetworkWrapper
     * @param opts any TxOptions defined
     * @returns a BlobEIP4844Transaction
     */
    static fromSerializedBlobTxNetworkWrapper(serialized, opts) {
        if (!opts || !opts.common) {
            throw new Error('common instance required to validate versioned hashes');
        }
        if (opts.common?.customCrypto?.kzg === undefined) {
            throw new Error('kzg instance required to instantiate blob tx');
        }
        if (equalsBytes(serialized.subarray(0, 1), txTypeBytes(TransactionType.BlobEIP4844)) === false) {
            throw new Error(`Invalid serialized tx input: not an EIP-4844 transaction (wrong tx type, expected: ${TransactionType.BlobEIP4844}, received: ${bytesToHex(serialized.subarray(0, 1))}`);
        }
        // Validate network wrapper
        const networkTxValues = RLP.decode(serialized.subarray(1));
        if (networkTxValues.length !== 4) {
            throw Error(`Expected 4 values in the deserialized network transaction`);
        }
        const [txValues, blobs, kzgCommitments, kzgProofs] = networkTxValues;
        // Construct the tx but don't freeze yet, we will assign blobs etc once validated
        const decodedTx = BlobEIP4844Transaction.fromValuesArray(txValues, { ...opts, freeze: false });
        if (decodedTx.to === undefined) {
            throw Error('BlobEIP4844Transaction can not be send without a valid `to`');
        }
        const version = Number(opts.common.param('sharding', 'blobCommitmentVersionKzg'));
        validateBlobTransactionNetworkWrapper(decodedTx.blobVersionedHashes, blobs, kzgCommitments, kzgProofs, version, opts.common.customCrypto.kzg);
        // set the network blob data on the tx
        decodedTx.blobs = blobs;
        decodedTx.kzgCommitments = kzgCommitments;
        decodedTx.kzgProofs = kzgProofs;
        // freeze the tx
        const freeze = opts?.freeze ?? true;
        if (freeze) {
            Object.freeze(decodedTx);
        }
        return decodedTx;
    }
    /**
     * The amount of gas paid for the data in this tx
     */
    getDataFee() {
        return getDataFee(this);
    }
    /**
     * The up front amount that an account must have for this transaction to be valid
     * @param baseFee The base fee of the block (will be set to 0 if not provided)
     */
    getUpfrontCost(baseFee = BIGINT_0) {
        return getUpfrontCost(this, baseFee);
    }
    /**
     * Returns a Uint8Array Array of the raw Bytes of the EIP-4844 transaction, in order.
     *
     * Format: [chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data,
     * access_list, max_fee_per_data_gas, blob_versioned_hashes, y_parity, r, s]`.
     *
     * Use {@link BlobEIP4844Transaction.serialize} to add a transaction to a block
     * with {@link Block.fromValuesArray}.
     *
     * For an unsigned tx this method uses the empty Bytes values for the
     * signature parameters `v`, `r` and `s` for encoding. For an EIP-155 compliant
     * representation for external signing use {@link BlobEIP4844Transaction.getMessageToSign}.
     */
    raw() {
        return [
            bigIntToUnpaddedBytes(this.chainId),
            bigIntToUnpaddedBytes(this.nonce),
            bigIntToUnpaddedBytes(this.maxPriorityFeePerGas),
            bigIntToUnpaddedBytes(this.maxFeePerGas),
            bigIntToUnpaddedBytes(this.gasLimit),
            this.to !== undefined ? this.to.bytes : new Uint8Array(0),
            bigIntToUnpaddedBytes(this.value),
            this.data,
            this.accessList,
            bigIntToUnpaddedBytes(this.maxFeePerBlobGas),
            this.blobVersionedHashes,
            this.v !== undefined ? bigIntToUnpaddedBytes(this.v) : new Uint8Array(0),
            this.r !== undefined ? bigIntToUnpaddedBytes(this.r) : new Uint8Array(0),
            this.s !== undefined ? bigIntToUnpaddedBytes(this.s) : new Uint8Array(0),
        ];
    }
    /**
     * Returns the serialized encoding of the EIP-4844 transaction.
     *
     * Format: `0x03 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data,
     * access_list, max_fee_per_data_gas, blob_versioned_hashes, y_parity, r, s])`.
     *
     * Note that in contrast to the legacy tx serialization format this is not
     * valid RLP any more due to the raw tx type preceding and concatenated to
     * the RLP encoding of the values.
     */
    serialize() {
        return serialize(this);
    }
    /**
     * @returns the serialized form of a blob transaction in the network wrapper format (used for gossipping mempool transactions over devp2p)
     */
    serializeNetworkWrapper() {
        if (this.blobs === undefined ||
            this.kzgCommitments === undefined ||
            this.kzgProofs === undefined) {
            throw new Error('cannot serialize network wrapper without blobs, KZG commitments and KZG proofs provided');
        }
        return serialize(this, [this.raw(), this.blobs, this.kzgCommitments, this.kzgProofs]);
    }
    /**
     * Returns the raw serialized unsigned tx, which can be used
     * to sign the transaction (e.g. for sending to a hardware wallet).
     *
     * Note: in contrast to the legacy tx the raw message format is already
     * serialized and doesn't need to be RLP encoded any more.
     *
     * ```javascript
     * const serializedMessage = tx.getMessageToSign() // use this for the HW wallet input
     * ```
     */
    getMessageToSign() {
        return serialize(this, this.raw().slice(0, 11));
    }
    /**
     * Returns the hashed serialized unsigned tx, which can be used
     * to sign the transaction (e.g. for sending to a hardware wallet).
     *
     * Note: in contrast to the legacy tx the raw message format is already
     * serialized and doesn't need to be RLP encoded any more.
     */
    getHashedMessageToSign() {
        return getHashedMessageToSign(this);
    }
    /**
     * Computes a sha3-256 hash of the serialized tx.
     *
     * This method can only be used for signed txs (it throws otherwise).
     * Use {@link BlobEIP4844Transaction.getMessageToSign} to get a tx hash for the purpose of signing.
     */
    hash() {
        return hash(this);
    }
    getMessageToVerifySignature() {
        return this.getHashedMessageToSign();
    }
    /**
     * Returns the public key of the sender
     */
    getSenderPublicKey() {
        return getSenderPublicKey(this);
    }
    toJSON() {
        const accessListJSON = AccessLists.getAccessListJSON(this.accessList);
        const baseJson = super.toJSON();
        return {
            ...baseJson,
            chainId: bigIntToHex(this.chainId),
            maxPriorityFeePerGas: bigIntToHex(this.maxPriorityFeePerGas),
            maxFeePerGas: bigIntToHex(this.maxFeePerGas),
            accessList: accessListJSON,
            maxFeePerBlobGas: bigIntToHex(this.maxFeePerBlobGas),
            blobVersionedHashes: this.blobVersionedHashes.map((hash) => bytesToHex(hash)),
        };
    }
    addSignature(v, r, s, convertV = false) {
        r = toBytes(r);
        s = toBytes(s);
        const opts = { ...this.txOptions, common: this.common };
        return BlobEIP4844Transaction.fromTxData({
            chainId: this.chainId,
            nonce: this.nonce,
            maxPriorityFeePerGas: this.maxPriorityFeePerGas,
            maxFeePerGas: this.maxFeePerGas,
            gasLimit: this.gasLimit,
            to: this.to,
            value: this.value,
            data: this.data,
            accessList: this.accessList,
            v: convertV ? v - BIGINT_27 : v,
            r: bytesToBigInt(r),
            s: bytesToBigInt(s),
            maxFeePerBlobGas: this.maxFeePerBlobGas,
            blobVersionedHashes: this.blobVersionedHashes,
            blobs: this.blobs,
            kzgCommitments: this.kzgCommitments,
            kzgProofs: this.kzgProofs,
        }, opts);
    }
    /**
     * Return a compact error string representation of the object
     */
    errorStr() {
        let errorStr = this._getSharedErrorPostfix();
        errorStr += ` maxFeePerGas=${this.maxFeePerGas} maxPriorityFeePerGas=${this.maxPriorityFeePerGas}`;
        return errorStr;
    }
    /**
     * Internal helper function to create an annotated error message
     *
     * @param msg Base error message
     * @hidden
     */
    _errorMsg(msg) {
        return errorMsg(this, msg);
    }
    /**
     * @returns the number of blobs included with this transaction
     */
    numBlobs() {
        return this.blobVersionedHashes.length;
    }
}

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

    blob = ethers.getBytes(blob);
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

    blobs = ethers.getBytes(blobs);
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

const stringToHex$1 = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));

async function readChunk(ethStorageRpc, ethStorageAddress, hexName, index) {
    let result;
    try {
        const provider = new ethers.JsonRpcProvider(ethStorageRpc);
        const contract = new Contract(ethStorageAddress, contractABI, provider);
        result = await contract.readChunk(hexName, index);
    } catch (e) {
        const provider = new ethers.JsonRpcProvider(ethStorageRpc);
        const contract = new Contract(ethStorageAddress, contractABI, provider);
        result = await contract.readChunk(hexName, index);
    }
    return ethers.getBytes(result[0]);
}

async function DownloadFile(ethStorageRpc, ethStorageAddress, fileName) {
    const hexName = stringToHex$1(fileName);

    const provider = new ethers.JsonRpcProvider(ethStorageRpc);
    const contract = new Contract(ethStorageAddress, contractABI, provider);
    const blobCount = await contract.countChunks(hexName);

    let buff = [];
    for (let i = 0; i < blobCount; i++) {
        const chunk = await readChunk(ethStorageRpc, ethStorageAddress, hexName, i);
        buff = [...buff, ...chunk];
    }
    return new Buffer(buff);
}

const flatDirectoryBlobAbi = [
    "constructor(uint8 slotLimit, uint32 maxChunkSize, address storageAddress) public",
    "function setDefault(bytes memory _defaultFile) public",
    "function upfrontPayment() external view returns (uint256)",
    "function getChunkHash(bytes memory name, uint256 chunkId) public view returns (bytes32)",
    "function writeChunks(bytes memory name, uint256[] memory chunkIds, uint256[] memory sizes) external payable",
    "function refund() public",
    "function remove(bytes memory name) external returns (uint256)",
    "function countChunks(bytes memory name) external view returns (uint256)",
    "function isSupportBlob() view public returns (bool)"
];

const REMOVE_FAIL = -1;
const REMOVE_NORMAL = 0;
const REMOVE_SUCCESS = 1;

const MAX_BLOB_COUNT = 3;

const SEPOLIA_ETH_STORAGE = "0x804C520d3c084C805E37A35E90057Ac32831F96f";
const ES_TEST_RPC = "http://65.108.236.27:9540";

const stringToHex = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));

class EthStorage {
    #wallet;
    #blobUploader;
    #contractAddr;

    constructor(rpc, privateKey, contractAddr = null) {
        const provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(privateKey, provider);
        this.#blobUploader = new BlobUploader(rpc, privateKey);
        this.#contractAddr = contractAddr;
    }

    async #deploy(ethStorage) {
        const contractByteCode = '0x60c0604052600060a09081526006906200001a9082620001ac565b503480156200002857600080fd5b50604051620038d0380380620038d08339810160408190526200004b9162000278565b60ff831660805282828281816200006233620000b5565b6002805463ffffffff909316600160a01b0263ffffffff60a01b1990931692909217909155600380546001600160a01b039092166001600160a01b031990921691909117905550620002e4945050505050565b600280546001600160a01b038381166001600160a01b0319831681179093556040519116919082907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a35050565b634e487b7160e01b600052604160045260246000fd5b600181811c908216806200013257607f821691505b6020821081036200015357634e487b7160e01b600052602260045260246000fd5b50919050565b601f821115620001a757600081815260208120601f850160051c81016020861015620001825750805b601f850160051c820191505b81811015620001a3578281556001016200018e565b5050505b505050565b81516001600160401b03811115620001c857620001c862000107565b620001e081620001d984546200011d565b8462000159565b602080601f831160018114620002185760008415620001ff5750858301515b600019600386901b1c1916600185901b178555620001a3565b600085815260208120601f198616915b82811015620002495788860151825594840194600190910190840162000228565b5085821015620002685787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b6000806000606084860312156200028e57600080fd5b835160ff81168114620002a057600080fd5b602085015190935063ffffffff81168114620002bb57600080fd5b60408501519092506001600160a01b0381168114620002d957600080fd5b809150509250925092565b6080516135c962000307600039600081816105500152611e9301526135c96000f3fe608060405260043610620001ee5760003560e01c8063590e1ae3116200010f578063caf1283611620000a3578063dd473fae116200006d578063dd473fae1462000776578063f14c7ad71462000794578063f2fde38b14620007ac578063f916c5b014620007d157620001ee565b8063caf1283614620006b5578063cf86bf9314620006f0578063d84eb56c146200072c578063dc38b0a2146200075157620001ee565b80638bf4515c11620000e55780638bf4515c14620006005780638da5cb5b146200062557806393b7628f1462000645578063956a3433146200069057620001ee565b8063590e1ae314620005ab5780635ba1d9e514620005c3578063715018a614620005e857620001ee565b80631ccbc6da116200018757806342216bed116200015d57806342216bed1462000504578063492c7b2a14620005295780634eed7cf1146200054057806358edef4c146200058657620001ee565b80631ccbc6da14620004ae5780631fbfa12714620004d55780632b68b9c614620004ec57620001ee565b806311ce026711620001c957806311ce026714620003de5780631a7237e014620004195780631c5ee10c146200044e5780631c993ad5146200048957620001ee565b8063038cd79f14620003705780630936286114620003895780631089f40f14620003b9575b348015620001fb57600080fd5b506000366060808284036200022157505060408051602081019091526000815262000365565b8383600081811062000237576200023762002a5f565b9050013560f81c60f81b6001600160f81b031916602f60f81b146200028357505060408051808201909152600e81526d0d2dcc6dee4e4cac6e840e0c2e8d60931b602082015262000365565b83836200029260018262002a8b565b818110620002a457620002a462002a5f565b909101356001600160f81b031916602f60f81b0390506200030657620002fd620002d2846001818862002aa1565b6006604051602001620002e89392919062002b03565b604051602081830303815290604052620007f6565b50905062000358565b6200035462000319846001818862002aa1565b8080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250620007f692505050565b5090505b6200036381620008a1565b505b915050805190602001f35b620003876200038136600462002ca3565b620008e2565b005b3480156200039657600080fd5b50620003a16200092c565b604051620003b0919062002d66565b60405180910390f35b348015620003c657600080fd5b5062000387620003d836600462002d7b565b620009c2565b348015620003eb57600080fd5b5060035462000400906001600160a01b031681565b6040516001600160a01b039091168152602001620003b0565b3480156200042657600080fd5b506200043e6200043836600462002da3565b62000a15565b604051620003b092919062002deb565b3480156200045b57600080fd5b50620004736200046d36600462002e11565b62000ac5565b60408051928352602083019190915201620003b0565b3480156200049657600080fd5b5062000387620004a836600462002e11565b62000b58565b348015620004bb57600080fd5b50620004c662000b97565b604051908152602001620003b0565b62000387620004e636600462002ed9565b62000c0d565b348015620004f957600080fd5b506200038762000d92565b3480156200051157600080fd5b50620004c66200052336600462002da3565b62000dcd565b620003876200053a36600462002f6a565b62000e78565b3480156200054d57600080fd5b507f000000000000000000000000000000000000000000000000000000000000000060ff1615155b6040519015158152602001620003b0565b3480156200059357600080fd5b50620004c6620005a536600462002e11565b62000f8f565b348015620005b857600080fd5b506200038762001057565b348015620005d057600080fd5b5062000575620005e236600462002da3565b620010c1565b348015620005f557600080fd5b506200038762001181565b3480156200060d57600080fd5b506200043e6200061f36600462002e11565b620007f6565b3480156200063257600080fd5b506002546001600160a01b031662000400565b3480156200065257600080fd5b50620006816200066436600462002e11565b805160209182012060009081526005909152604090205460ff1690565b604051620003b0919062002ff6565b3480156200069d57600080fd5b50620004c6620006af36600462003013565b620011bc565b348015620006c257600080fd5b50620006da620006d436600462002da3565b62001276565b60408051928352901515602083015201620003b0565b348015620006fd57600080fd5b506002546200071690600160a01b900463ffffffff1681565b60405163ffffffff9091168152602001620003b0565b3480156200073957600080fd5b50620004c66200074b36600462002da3565b6200130c565b3480156200075e57600080fd5b50620003876200077036600462003036565b620013c2565b3480156200078357600080fd5b50651b585b9d585b60d21b620004c6565b348015620007a157600080fd5b506200057562001411565b348015620007b957600080fd5b5062000387620007cb36600462003036565b6200143d565b348015620007de57600080fd5b50620004c6620007f036600462002e11565b620014dc565b60606000806200081d84805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000836576200083662002fe0565b0362000858576200084e848051906020012062001561565b9250925050915091565b60018160028111156200086f576200086f62002fe0565b0362000887576200084e848051906020012062001761565b505060408051600080825260208201909252939092509050565b600081516040620008b3919062003061565b9050601f19620008c582602062003061565b620008d290601f62003061565b1690506020808303528060208303f35b6002546001600160a01b03163314620009185760405162461bcd60e51b81526004016200090f9062003077565b60405180910390fd5b62000927836000848462000e78565b505050565b600680546200093b9062002acd565b80601f0160208091040260200160405190810160405280929190818152602001828054620009699062002acd565b8015620009ba5780601f106200098e57610100808354040283529160200191620009ba565b820191906000526020600020905b8154815290600101906020018083116200099c57829003601f168201915b505050505081565b6002546001600160a01b03163314620009ef5760405162461bcd60e51b81526004016200090f9062003077565b6002805463ffffffff909216600160a01b0263ffffffff60a01b19909216919091179055565b606060008062000a3c85805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000a555762000a5562002fe0565b0362000a795762000a6e8580519060200120856200188e565b925092505062000abe565b600181600281111562000a905762000a9062002fe0565b0362000aa95762000a6e8580519060200120856200196b565b50506040805160008082526020820190925291505b9250929050565b600080600062000aec84805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000b055762000b0562002fe0565b0362000b1d576200084e8480519060200120620019e4565b600181600281111562000b345762000b3462002fe0565b0362000b4c576200084e848051906020012062001abb565b50600093849350915050565b6002546001600160a01b0316331462000b855760405162461bcd60e51b81526004016200090f9062003077565b600662000b938282620030f6565b5050565b60035460408051630e65e36d60e11b815290516000926001600160a01b031691631ccbc6da9160048083019260209291908290030181865afa15801562000be2573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062000c089190620031c2565b905090565b6002546001600160a01b0316331462000c3a5760405162461bcd60e51b81526004016200090f9062003077565b62000c4462001411565b62000cab5760405162461bcd60e51b815260206004820152603060248201527f5468652063757272656e74206e6574776f726b20646f6573206e6f742073757060448201526f1c1bdc9d08189b1bd8881d5c1b1bd85960821b60648201526084016200090f565b600062000ccf84805160209182012060009081526005909152604090205460ff1690565b9050600081600281111562000ce85762000ce862002fe0565b148062000d095750600281600281111562000d075762000d0762002fe0565b145b62000d4e5760405162461bcd60e51b8152602060048201526014602482015273496e76616c69642073746f72616765206d6f646560601b60448201526064016200090f565b600081600281111562000d655762000d6562002fe0565b0362000d785762000d7884600262001b12565b62000d8c8480519060200120848462001b54565b50505050565b6002546001600160a01b0316331462000dbf5760405162461bcd60e51b81526004016200090f9062003077565b6002546001600160a01b0316ff5b60008062000df284805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000e0b5762000e0b62002fe0565b0362000e2d5762000e24848051906020012084620011bc565b91505062000e72565b600181600281111562000e445762000e4462002fe0565b0362000e6c57600062000e58858562000a15565b508051602090910120925062000e72915050565b50600090505b92915050565b6002546001600160a01b0316331462000ea55760405162461bcd60e51b81526004016200090f9062003077565b600062000ec985805160209182012060009081526005909152604090205460ff1690565b9050600081600281111562000ee25762000ee262002fe0565b148062000f035750600181600281111562000f015762000f0162002fe0565b145b62000f485760405162461bcd60e51b8152602060048201526014602482015273496e76616c69642073746f72616765206d6f646560601b60448201526064016200090f565b600081600281111562000f5f5762000f5f62002fe0565b0362000f725762000f7285600162001b12565b62000f8885805190602001208585853462001e83565b5050505050565b6002546000906001600160a01b0316331462000fbf5760405162461bcd60e51b81526004016200090f9062003077565b600062000fe383805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562000ffc5762000ffc62002fe0565b036200101d57620010168380519060200120600062001f6c565b9392505050565b600181600281111562001034576200103462002fe0565b036200104e57620010168380519060200120600062001fcc565b50600092915050565b6002546001600160a01b03163314620010845760405162461bcd60e51b81526004016200090f9062003077565b6002546040516001600160a01b03909116904780156108fc02916000818181858888f19350505050158015620010be573d6000803e3d6000fd5b50565b6002546000906001600160a01b03163314620010f15760405162461bcd60e51b81526004016200090f9062003077565b60006200111584805160209182012060009081526005909152604090205460ff1690565b905060028160028111156200112e576200112e62002fe0565b03620011475762000e248480519060200120846200208e565b60018160028111156200115e576200115e62002fe0565b03620011775762000e2484805190602001208462002116565b5060009392505050565b6002546001600160a01b03163314620011ae5760405162461bcd60e51b81526004016200090f9062003077565b620011ba600062002206565b565b6000620011c98362002258565b8210620011d95750600062000e72565b60035460008481526004602081815260408084208785529091529182902054915163d8389dc560e01b8152908101919091526001600160a01b039091169063d8389dc590602401602060405180830381865afa1580156200123e573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190620012649190620031dc565b67ffffffffffffffff19169392505050565b60008060006200129d85805160209182012060009081526005909152604090205460ff1690565b90506002816002811115620012b657620012b662002fe0565b03620012cf5762000a6e85805190602001208562002299565b6001816002811115620012e657620012e662002fe0565b03620012ff5762000a6e8580519060200120856200234d565b5060009485945092505050565b6002546000906001600160a01b031633146200133c5760405162461bcd60e51b81526004016200090f9062003077565b60006200136084805160209182012060009081526005909152604090205460ff1690565b9050600281600281111562001379576200137962002fe0565b03620013925762000e2484805190602001208462001f6c565b6001816002811115620013a957620013a962002fe0565b03620011775762000e2484805190602001208462001fcc565b6002546001600160a01b03163314620013ef5760405162461bcd60e51b81526004016200090f9062003077565b600380546001600160a01b0319166001600160a01b0392909216919091179055565b6003546000906001600160a01b03161580159062000c08575060006200143662000b97565b1015905090565b6002546001600160a01b031633146200146a5760405162461bcd60e51b81526004016200090f9062003077565b6001600160a01b038116620014d15760405162461bcd60e51b815260206004820152602660248201527f4f776e61626c653a206e6577206f776e657220697320746865207a65726f206160448201526564647265737360d01b60648201526084016200090f565b620010be8162002206565b6000806200150183805160209182012060009081526005909152604090205460ff1690565b905060028160028111156200151a576200151a62002fe0565b03620015325762001016838051906020012062002258565b600181600281111562001549576200154962002fe0565b036200104e57620010168380519060200120620023a5565b606060008060006200157385620019e4565b9150915080600003620015bb5760005b6040519080825280601f01601f191660200182016040528015620015ae576020820181803683370190505b5095600095509350505050565b6000826001600160401b03811115620015d857620015d862002b90565b6040519080825280601f01601f19166020018201604052801562001603576020820181803683370190505b5090506000805b838110156200175257600088815260046020818152604080842085855290915280832054600354915163afd5644d60e01b815292830181905292916001600160a01b039091169063afd5644d90602401602060405180830381865afa15801562001678573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906200169e9190620031c2565b60035460405163bea94b8b60e01b81529192506001600160a01b03169063bea94b8b90620016d9908590600190600090879060040162003209565b600060405180830381865afa158015620016f7573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f191682016040526200172191908101906200323e565b508060406020868801013e62001738818562003061565b9350505080806200174990620032bd565b9150506200160a565b50909660019650945050505050565b60606000806000620017738562001abb565b91509150806000036200178857600062001583565b6000826001600160401b03811115620017a557620017a562002b90565b6040519080825280601f01601f191660200182016040528015620017d0576020820181803683370190505b5090506020810160005b838110156200175257600088815260208181526040808320848452909152812054906200180782620023e4565b156200184957620018188260e01c90565b60008b8152600160209081526040808320878452909152902090915062001841908386620023f9565b505062001868565b816200185581620024ad565b50915062001864818662002513565b5050505b62001874818562003061565b9350505080806200188590620032bd565b915050620017da565b60606000806200189f858562002299565b5090506001811015620018c657505060408051600080825260208201909252915062000abe565b600354600086815260046020818152604080842089855290915280832054905163bea94b8b60e01b815292936001600160a01b03169263bea94b8b92620019169291600191879189910162003209565b600060405180830381865afa15801562001934573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f191682016040526200195e91908101906200323e565b9660019650945050505050565b600082815260208181526040808320848452909152812054606091906200199281620023e4565b15620019cc5760008581526001602090815260408083208784529091528120620019bd908362002572565b93506001925062000abe915050565b80620019d88162002619565b93509350505062000abe565b6000806000620019f48462002258565b90506000805b8281101562001ab15760035460008781526004602081815260408084208685529091529182902054915163afd5644d60e01b8152908101919091526001600160a01b039091169063afd5644d90602401602060405180830381865afa15801562001a68573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062001a8e9190620031c2565b62001a9a908362003061565b91508062001aa881620032bd565b915050620019fa565b5094909350915050565b6000806000805b60008062001ad187846200234d565b915091508062001ae357505062001b08565b62001aef828562003061565b93508262001afd81620032bd565b935050505062001ac2565b9094909350915050565b81516020808401919091206000908152600590915260409020805482919060ff1916600183600281111562001b4b5762001b4b62002fe0565b02179055505050565b815160035460408051630e65e36d60e11b815290516000926001600160a01b031691631ccbc6da9160048083019260209291908290030181865afa15801562001ba1573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062001bc79190620031c2565b905062001bd58282620032d9565b34101562001c1d5760405162461bcd60e51b8152602060048201526014602482015273696e73756666696369656e742062616c616e636560601b60448201526064016200090f565b60005b828160ff16101562001e7b57838160ff168151811062001c445762001c4462002a5f565b6020026020010151600010801562001c935750600260149054906101000a900463ffffffff1663ffffffff16848260ff168151811062001c885762001c8862002a5f565b602002602001015111155b62001cd85760405162461bcd60e51b81526020600482015260146024820152730d2dcecc2d8d2c840c6d0eadcd640d8cadccee8d60631b60448201526064016200090f565b62001d0386868360ff168151811062001cf55762001cf562002a5f565b6020026020010151620026bf565b60003387878460ff168151811062001d1f5762001d1f62002a5f565b602002602001015160405160200162001d56939291906001600160a01b039390931683526020830191909152604082015260600190565b604051602081830303815290604052805190602001209050600360009054906101000a90046001600160a01b03166001600160a01b0316634581a920848385898760ff168151811062001dad5762001dad62002a5f565b60200260200101516040518563ffffffff1660e01b815260040162001de89392919092835260ff919091166020830152604082015260600190565b6000604051808303818588803b15801562001e0257600080fd5b505af115801562001e17573d6000803e3d6000fd5b505050505080600460008981526020019081526020016000206000888560ff168151811062001e4a5762001e4a62002a5f565b602002602001015181526020019081526020016000208190555050808062001e7290620032f3565b91505062001c20565b505050505050565b62001e8f85856200275d565b60ff7f00000000000000000000000000000000000000000000000000000000000000001682111562001ef65762001ed862001ecc84848462002875565b6001600160a01b031690565b60008681526020818152604080832088845290915290205562000f88565b60008581526001602090815260408083208784528252918290208251601f860183900483028101830190935284835262001f4d92909186908690819084018382808284376000920191909152506200293192505050565b6000868152602081815260408083208884529091529020555050505050565b60005b60008381526004602090815260408083208584529091529020548062001f96575062001fc6565b60008481526004602090815260408083208684529091528120558262001fbc81620032bd565b9350505062001f6f565b50919050565b60005b6000838152602081815260408083208584529091529020548062001ff4575062001fc6565b62001fff81620023e4565b62002060576000819050806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b1580156200204557600080fd5b505af11580156200205a573d6000803e3d6000fd5b50505050505b600084815260208181526040808320868452909152812055826200208481620032bd565b9350505062001fcf565b600082815260046020908152604080832084845290915281205480620020b957600091505062000e72565b600084815260046020526040812081620020d586600162003061565b81526020019081526020016000205414620020f557600091505062000e72565b50506000918252600460209081526040808420928452919052812055600190565b600082815260208181526040808320848452909152812054806200213f57600091505062000e72565b6000848152602081905260408120816200215b86600162003061565b815260200190815260200160002054146200217b57600091505062000e72565b6200218681620023e4565b620021e7576000819050806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b158015620021cc57600080fd5b505af1158015620021e1573d6000803e3d6000fd5b50505050505b5050600091825260208281526040808420928452919052812055600190565b600280546001600160a01b038381166001600160a01b0319831681179093556040519116919082907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a35050565b6000805b60008381526004602090815260408083208484529091529020548062002283575062000e72565b816200228f81620032bd565b925050506200225c565b600080620022a78462002258565b8310620022ba5750600090508062000abe565b600354600085815260046020818152604080842088855290915280832054905163afd5644d60e01b81529182015290916001600160a01b03169063afd5644d90602401602060405180830381865afa1580156200231b573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190620023419190620031c2565b95600195509350505050565b6000828152602081815260408083208484529091528120548190806200237b57600080925092505062000abe565b6200238681620023e4565b1562002399576000620019bd8260e01c90565b80620019d881620024ad565b6000805b60008381526020818152604080832084845290915290205480620023ce575062000e72565b81620023da81620032bd565b92505050620023a9565b600080620023f28360e01c90565b1192915050565b60008060006200240985620029cb565b808652909350905083601c8411156200249f57601c81016000805b6020600162002435601c8a62002a8b565b6200244290602062003061565b6200244e919062002a8b565b6200245a919062003315565b8110156200249b57600081815260208b815260409091205480855292506200248490849062003061565b9250806200249281620032bd565b91505062002424565b5050505b600192505050935093915050565b6000806001600160a01b038316620024ca57506000928392509050565b60008060405180610160016040528061012681526020016200346e6101269139519050843b91508082101562002507575060009485945092505050565b62002341818362002a8b565b6000806000806200252486620024ad565b91509150806200253d5760008093509350505062000abe565b600060405180610160016040528061012681526020016200346e6101269139519050828187893c509095600195509350505050565b606060006200258183620029e6565b92509050601c8111156200261257603c82016000805b60206001620025a8601c8762002a8b565b620025b590602062003061565b620025c1919062002a8b565b620025cd919062003315565b8110156200260e57600081815260208881526040909120548085529250620025f790849062003061565b9250806200260581620032bd565b91505062002597565b5050505b5092915050565b606060008060006200262b85620024ad565b91509150806200263d57600062001583565b6000826001600160401b038111156200265a576200265a62002b90565b6040519080825280601f01601f19166020018201604052801562002685576020820181803683370190505b509050600060405180610160016040528061012681526020016200346e6101269139519050838160208401893c5095600195509350505050565b60008281526004602090815260408083208484529091529020548062000927578115806200271657506000838152600460205260408120816200270460018662002a8b565b81526020019081526020016000205414155b620009275760405162461bcd60e51b81526020600482015260166024820152751b5d5cdd081c995c1b1858d9481bdc88185c1c195b9960521b60448201526064016200090f565b60008281526020818152604080832084845290915290205480620027f957811580620027b25750600083815260208190526040812081620027a060018662002a8b565b81526020019081526020016000205414155b620027f95760405162461bcd60e51b81526020600482015260166024820152751b5d5cdd081c995c1b1858d9481bdc88185c1c195b9960521b60448201526064016200090f565b6200280481620023e4565b6200092757806001600160a01b0381161562000d8c57806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b1580156200285657600080fd5b505af11580156200286b573d6000803e3d6000fd5b5050505050505050565b60008060405180610160016040528061012681526020016200346e61012691398585604051602001620028ab9392919062003338565b60408051601f1981840301815291905290506000620028cd6043602062003061565b30838201529050620028e2608c602062003061565b905030818301525060008382604051620028fc9062002a51565b62002908919062002d66565b6040518091039082f090508015801562002926573d6000803e3d6000fd5b509695505050505050565b805160208083015160e083901b911c1790601c81111562002612576000603c8401815b6020600162002965601c8762002a8b565b6200297290602062003061565b6200297e919062002a8b565b6200298a919062003315565b8110156200260e5781519250620029a382602062003061565b6000828152602089905260409020849055915080620029c281620032bd565b91505062002954565b600080620029d98360e01c90565b9360209390931b92915050565b60006060620029f58360e01c90565b9150602083901b9250816001600160401b0381111562002a195762002a1962002b90565b6040519080825280601f01601f19166020018201604052801562002a44576020820181803683370190505b5060208101939093525091565b61010b806200336383390190565b634e487b7160e01b600052603260045260246000fd5b634e487b7160e01b600052601160045260246000fd5b8181038181111562000e725762000e7262002a75565b6000808585111562002ab257600080fd5b8386111562002ac057600080fd5b5050820193919092039150565b600181811c9082168062002ae257607f821691505b60208210810362001fc657634e487b7160e01b600052602260045260246000fd5b828482376000838201600081526000845462002b1f8162002acd565b6001828116801562002b3a576001811462002b505762002b81565b60ff198416865282151583028601945062002b81565b8860005260208060002060005b8581101562002b785781548982015290840190820162002b5d565b50505082860194505b50929998505050505050505050565b634e487b7160e01b600052604160045260246000fd5b604051601f8201601f191681016001600160401b038111828210171562002bd15762002bd162002b90565b604052919050565b60006001600160401b0382111562002bf55762002bf562002b90565b50601f01601f191660200190565b600082601f83011262002c1557600080fd5b813562002c2c62002c268262002bd9565b62002ba6565b81815284602083860101111562002c4257600080fd5b816020850160208301376000918101602001919091529392505050565b60008083601f84011262002c7257600080fd5b5081356001600160401b0381111562002c8a57600080fd5b60208301915083602082850101111562000abe57600080fd5b60008060006040848603121562002cb957600080fd5b83356001600160401b038082111562002cd157600080fd5b62002cdf8783880162002c03565b9450602086013591508082111562002cf657600080fd5b5062002d058682870162002c5f565b9497909650939450505050565b60005b8381101562002d2f57818101518382015260200162002d15565b50506000910152565b6000815180845262002d5281602086016020860162002d12565b601f01601f19169290920160200192915050565b60208152600062001016602083018462002d38565b60006020828403121562002d8e57600080fd5b813563ffffffff811681146200101657600080fd5b6000806040838503121562002db757600080fd5b82356001600160401b0381111562002dce57600080fd5b62002ddc8582860162002c03565b95602094909401359450505050565b60408152600062002e00604083018562002d38565b905082151560208301529392505050565b60006020828403121562002e2457600080fd5b81356001600160401b0381111562002e3b57600080fd5b62002e498482850162002c03565b949350505050565b600082601f83011262002e6357600080fd5b813560206001600160401b0382111562002e815762002e8162002b90565b8160051b62002e9282820162002ba6565b928352848101820192828101908785111562002ead57600080fd5b83870192505b8483101562002ece5782358252918301919083019062002eb3565b979650505050505050565b60008060006060848603121562002eef57600080fd5b83356001600160401b038082111562002f0757600080fd5b62002f158783880162002c03565b9450602086013591508082111562002f2c57600080fd5b62002f3a8783880162002e51565b9350604086013591508082111562002f5157600080fd5b5062002f608682870162002e51565b9150509250925092565b6000806000806060858703121562002f8157600080fd5b84356001600160401b038082111562002f9957600080fd5b62002fa78883890162002c03565b955060208701359450604087013591508082111562002fc557600080fd5b5062002fd48782880162002c5f565b95989497509550505050565b634e487b7160e01b600052602160045260246000fd5b60208101600383106200300d576200300d62002fe0565b91905290565b600080604083850312156200302757600080fd5b50508035926020909101359150565b6000602082840312156200304957600080fd5b81356001600160a01b03811681146200101657600080fd5b8082018082111562000e725762000e7262002a75565b6020808252818101527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604082015260600190565b601f8211156200092757600081815260208120601f850160051c81016020861015620030d55750805b601f850160051c820191505b8181101562001e7b57828155600101620030e1565b81516001600160401b0381111562003112576200311262002b90565b6200312a8162003123845462002acd565b84620030ac565b602080601f831160018114620031625760008415620031495750858301515b600019600386901b1c1916600185901b17855562001e7b565b600085815260208120601f198616915b82811015620031935788860151825594840194600190910190840162003172565b5085821015620031b25787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b600060208284031215620031d557600080fd5b5051919050565b600060208284031215620031ef57600080fd5b815167ffffffffffffffff19811681146200101657600080fd5b848152608081016002851062003223576200322362002fe0565b84602083015283604083015282606083015295945050505050565b6000602082840312156200325157600080fd5b81516001600160401b038111156200326857600080fd5b8201601f810184136200327a57600080fd5b80516200328b62002c268262002bd9565b818152856020838501011115620032a157600080fd5b620032b482602083016020860162002d12565b95945050505050565b600060018201620032d257620032d262002a75565b5060010190565b808202811582820484141762000e725762000e7262002a75565b600060ff821660ff81036200330c576200330c62002a75565b60010192915050565b6000826200333357634e487b7160e01b600052601260045260246000fd5b500490565b600084516200334c81846020890162002d12565b820183858237600093019283525090939250505056fe608060405260405161010b38038061010b83398101604081905261002291610041565b80518060208301f35b634e487b7160e01b600052604160045260246000fd5b6000602080838503121561005457600080fd5b82516001600160401b038082111561006b57600080fd5b818501915085601f83011261007f57600080fd5b8151818111156100915761009161002b565b604051601f8201601f19908116603f011681019083821181831017156100b9576100b961002b565b8160405282815288868487010111156100d157600080fd5b600093505b828410156100f357848401860151818501870152928501926100d6565b60008684830101528096505050505050509291505056fe6080604052348015600f57600080fd5b506004361060325760003560e01c80632b68b9c61460375780638da5cb5b14603f575b600080fd5b603d6081565b005b60657f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b03909116815260200160405180910390f35b336001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000161460ed5760405162461bcd60e51b815260206004820152600e60248201526d3737ba10333937b69037bbb732b960911b604482015260640160405180910390fd5b33fffea2646970667358221220fc66c9afb7cb2f6209ae28167cf26c6c06f86a82cbe3c56de99027979389a1be64736f6c63430008070033a264697066735822122074ecdb7c1356cd26b7ae20a002751e685b2c97645c0ec1b1214c316ec9516dce64736f6c63430008120033';
        const factory = new ethers.ContractFactory(flatDirectoryBlobAbi, contractByteCode, this.#wallet);
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

    async deployDirectory(ethStorage) {
        return this.#deploy(ethStorage);
    }

    async deployNormalDirectory() {
        return this.deployDirectory("0x0000000000000000000000000000000000000000");
    }

    async deploySepoliaDirectory() {
        return this.deployDirectory(SEPOLIA_ETH_STORAGE);
    }

    async setDefaultFile(filename) {
        if (!this.#contractAddr) {
            console.error(`ERROR: flat directory not deployed!`);
            return;
        }

        const hexName = filename ? stringToHex(filename) : "0x";
        const fileContract = new ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
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

        const fileContract = new ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
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
        const fileContract = new ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
        try {
            const tx = await fileContract.remove(stringToHex(fileName));
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

    async #clearOldFile(fileContract, fileName, hexName, chunkLength) {
        let oldChunkLength = await fileContract.countChunks(hexName);
        if (oldChunkLength > chunkLength) {
            // remove
            const v = await this.remove(fileName);
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

    async upload(fileOrPath) {
        if (!this.#contractAddr) {
            console.error(`ERROR: flat directory not deployed!`);
            return;
        }

        const fileInfo = this.getFileInfo(fileOrPath);
        if (!fileInfo.isFile) {
            console.error(`ERROR: only upload file!`);
            return;
        }

        const fileContract = new ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
        const isSupport = await fileContract.isSupportBlob();
        if (!isSupport) {
            console.error(`ERROR: The current contract does not support blob upload!`);
            return;
        }

        const fileSize = fileInfo.size;
        const fileName = fileInfo.name;
        const hexName = stringToHex(fileName);

        const blobDataSize = BLOB_DATA_SIZE;
        const blobLength = Math.ceil(fileSize / blobDataSize);

        const clearState = await this.#clearOldFile(fileContract, fileName, hexName, blobLength);
        if (clearState === REMOVE_FAIL) {
            return {
                totalChunkCount: blobLength,
                successIndex: 0,
                uploadSuccessCount: 0,
                uploadFileSize: 0,
                totalCost: 0,
            };
        }

        const cost = await fileContract.upfrontPayment();
        let successIndex = 0;
        let uploadCount = 0;
        let uploadFileSize = 0;
        let totalCost = 0n;
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const content = this.getFileChunk(fileOrPath, fileSize, i * blobDataSize, (i + MAX_BLOB_COUNT) * blobDataSize);
            const blobs = EncodeBlobs(content);

            const blobArr = [];
            const indexArr = [];
            const lenArr = [];
            for (let j = 0; j < blobs.length; j++) {
                blobArr.push(blobs[j]);
                indexArr.push(i + j);
                if (i + j === blobLength - 1) {
                    lenArr.push(fileSize - blobDataSize * (blobLength - 1));
                } else {
                    lenArr.push(blobDataSize);
                }
            }

            // check
            if (clearState === REMOVE_NORMAL) {
                let hasChange = false;
                for (let j = 0; j < blobArr.length; j++) {
                    const dataHash = await fileContract.getChunkHash(hexName, indexArr[j]);
                    const localHash = await this.#blobUploader.getBlobHash(blobArr[j]);
                    if (dataHash !== localHash) {
                        hasChange = true;
                        break;
                    }
                }
                if (!hasChange) {
                    successIndex += indexArr.length;
                    console.log(`File ${fileName} chunkId: ${indexArr}: The data is not changed.`);
                    continue;
                }
            }

            // send
            let success = false;
            try {
                const value = cost * BigInt(blobArr.length);
                const tx = await fileContract.writeChunks.populateTransaction(hexName, indexArr, lenArr, {
                    value
                });
                const hash = await this.#blobUploader.sendTx(tx, blobArr);
                console.log(`Transaction Id: ${hash}`);

                const txReceipt = await this.#blobUploader.getTxReceipt(hash);
                if (txReceipt && txReceipt.status) {
                    success = true;
                    totalCost += value;
                    uploadFileSize += BLOB_DATA_SIZE * indexArr.length;
                    if (i + indexArr.length === blobLength) {
                        uploadFileSize = uploadFileSize - BLOB_DATA_SIZE + lenArr[lenArr.length - 1];
                    }
                    uploadCount += indexArr.length;
                    successIndex += indexArr.length;
                    console.log(`File ${fileName} chunkId: ${indexArr} uploaded!`);
                }
            } catch (e) {
                console.log('Error:' + e.message);
            }
            if (!success) {
                break;
            }
        }
        return {
            totalChunkCount: blobLength,
            successIndex: successIndex,
            uploadSuccessCount: uploadCount,
            uploadFileSize: uploadFileSize,
            totalCost: totalCost,
        }
    }

    async download(fileName, ethStorageRpc = ES_TEST_RPC) {
        if (!this.#contractAddr) {
            console.error(`ERROR: flat directory not deployed!`);
            return;
        }
        return await DownloadFile(ethStorageRpc, this.#contractAddr, fileName);
    }

    getFileInfo(filePath) {}
    getFileChunk(filePath, fileSize, start, end) {}
}

class EthStorageBrowser extends EthStorage{
    getFileInfo(file) {
        return {
            isFile: true,
            name: file.name,
            size: file.size
        };
    }

    getFileChunk(file, fileSize, start, end) {
        end = end > fileSize ? fileSize : end;
        const slice = file.slice(start, end);
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (res) => {
                resolve(Buffer.from(res.target.result));
            };
            reader.readAsArrayBuffer(slice);
        });
    }
}

export { BLOB_DATA_SIZE, BLOB_SIZE, BlobUploader, DecodeBlob, DecodeBlobs, DownloadFile, EncodeBlobs, EthStorageBrowser };
//# sourceMappingURL=index.esm.js.map
