import {ethers} from "ethers";
import {copy} from "./util";

const BlobTxBytesPerFieldElement         = 32;      // Size in bytes of a field element
const BlobTxFieldElementsPerBlob         = 4096;
const BLOB_SIZE = BlobTxBytesPerFieldElement * BlobTxFieldElementsPerBlob;

export function encodeBlobs(data) {
    const len = data.length;
    if (len === 0) {
        throw Error('Blobs: invalid blob data')
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

export function decodeBlob(blob) {
    if (!blob) {
        throw Error('Blobs: invalid blob data')
    }

    blob = ethers.getBytes(blob);
    if (blob.length < BLOB_SIZE) {
        const newBlob = new Uint8Array(BLOB_SIZE).fill(0);
        newBlob.set(blob);
        blob = newBlob;
    }

    let data = [];
    let j = 0
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

export function decodeBlobs(blobs) {
    if (!blobs) {
        throw Error('Blobs: invalid blobs')
    }

    blobs = ethers.getBytes(blobs);
    const len = blobs.length;
    if (len === 0) {
        throw Error('Blobs: invalid blobs')
    }

    let buf = [];
    for (let i = 0; i < len; i += BLOB_SIZE) {
        let max = i + BLOB_SIZE;
        if (max > len) {
            max = len;
        }
        const blob = blobs.subarray(i, max);
        const blobBuf = decodeBlob(blob);
        buf = [...buf, ...blobBuf];
    }
    return new Buffer(buf);
}


// OP BLOB
const MaxBlobDataSize = (4 * 31 + 3) * 1024 - 4
const EncodingVersion = 0
const Rounds = 1024 // number of encode/decode rounds

export function encodeOpBlobs(data) {
    const len = data.length;
    if (len === 0) {
        throw Error('invalid blob data')
    }
    const blobs = [];
    for (let i = 0; i < len; i += MaxBlobDataSize) {
        let max = i + MaxBlobDataSize;
        if (max > len) {
            max = len;
        }
        const blob = encodeOpBlob(data.subarray(i, max));
        blobs.push(blob);
    }
    return blobs;
}

export function encodeOpBlob(data) {
    if (data.length > MaxBlobDataSize) {
        throw new Error(`too much data to encode in one blob, len=${data.length}`);
    }

    const b = new Uint8Array(BLOB_SIZE).fill(0);
    let readOffset = 0;

    // read 1 byte of input, 0 if there is no input left
    const read1 = function () {
        if (readOffset >= data.length) {
            return 0;
        }
        let out = data[readOffset];
        readOffset += 1;
        return out;
    }

    let writeOffset = 0;
    let buf31 = new Uint8Array(31);
    let zero31 = new Uint8Array(31);
    // Read up to 31 bytes of input (left-aligned), into buf31.
    const read31 = function() {
        if  (readOffset >= data.length) {
            copy(buf31, 0, zero31, 0);
            return;
        }

        let n = copy(buf31, 0, data, readOffset); // copy as much data as we can
        copy(buf31, n, zero31, 0);       // pad with zeroes (since there might not be enough data)
        readOffset += n
    }
    // Write a byte, updates the write-offset.
    // Asserts that the write-offset matches encoding-algorithm expectations.
    // Asserts that the value is 6 bits.
    const write1 = function(v) {
        if (writeOffset % 32 !== 0) {
            throw new Error(`blob encoding: invalid byte write offset: ${writeOffset}`);
        }

        const tag = v & 0b1100_0000;
        if (tag !== 0) {
            throw new Error(`blob encoding: invalid 6 bit value: 0b${v}`);
        }
        b[writeOffset] = v
        writeOffset += 1
    }
    // Write buf31 to the blob, updates the write-offset.
    // Asserts that the write-offset matches encoding-algorithm expectations.
    const write31 = function() {
        if (writeOffset%32 !== 1) {
            throw new Error(`blob encoding: invalid bytes31 write offset: ${writeOffset}`);
        }

        copy(b,writeOffset, buf31, 0);
        writeOffset += 31;
    }

    for (let round = 0; round < Rounds && readOffset < data.length; round++) {
        // The first field element encodes the version and the length of the data in [1:5].
        // This is a manual substitute for read31(), preparing the buf31.
        if (round === 0) {
            buf31[0] = EncodingVersion
            // Encode the length as big-endian uint24.
            // The length check at the start above ensures we can always fit the length value into only 3 bytes.
            let ilen = data.length
            buf31[1] = ilen >> 16
            buf31[2] = ilen >> 8
            buf31[3] = ilen

            readOffset += copy(buf31, 4, data, 0)
        } else {
            read31()
        }

        let x = read1()
        let A = x & 0b0011_1111
        write1(A)
        write31()

        read31()
        let y = read1()
        let B = (y & 0b0000_1111) | ((x & 0b1100_0000) >> 2)
        write1(B)
        write31()

        read31()
        let z = read1()
        let C = z & 0b0011_1111
        write1(C)
        write31()

        read31()
        let D = ((z & 0b1100_0000) >> 2) | ((y & 0b1111_0000) >> 4)
        write1(D)
        write31()
    }

    if (readOffset < data.length) {
        throw new Error(`expected to fit data but failed, read offset: ${readOffset}, data: ${data}" `);
    }
    return b;
}
