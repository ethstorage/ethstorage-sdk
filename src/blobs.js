const {ethers} = require("ethers");

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
    const newData = data.slice(0, i + 1);
    return newData;
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

module.exports = {
    EncodeBlobs,
    DecodeBlobs,
    DecodeBlob,
    BLOB_SIZE,
    BLOB_DATA_SIZE
}
