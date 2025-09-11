
const MAINNET_CHAIN_ID: number = 1;
const SEPOLIA_CHAIN_ID: number = 11155111;
const QUARKCHAIN_L2_TESTNET_CHAIN_ID: number = 3335;

export const ETHSTORAGE_MAPPING: Record<number, string> = {
    [MAINNET_CHAIN_ID]: '0xf0193d6E8fc186e77b6E63af4151db07524f6a7A',
    [SEPOLIA_CHAIN_ID]: '0xAb3d380A268d088BA21Eb313c1C23F3BEC5cfe93',
    [QUARKCHAIN_L2_TESTNET_CHAIN_ID]: '0x64003adbdf3014f7E38FC6BE752EB047b95da89A',
};



const BlobTxBytesPerFieldElement: number = 32;      // Size in bytes of a field element
const BlobTxFieldElementsPerBlob: number = 4096;
export const BLOB_SIZE: number = BlobTxBytesPerFieldElement * BlobTxFieldElementsPerBlob;

export const OP_BLOB_DATA_SIZE: number = (4 * 31 + 3) * 1024 - 4;


// DecodeType
export enum DecodeType {
    RawData,
    PaddingPer31Bytes,
    OptimismCompact,
}

export const BLOB_COUNT_LIMIT: number = 6;
export const MAX_BLOB_COUNT: number = 3;


export enum UploadType {
    Undefined,
    Calldata,
    Blob,
}


export const MAX_RETRIES: number = 3;

/**
 * eth_call consumes gas, so we need to estimate the maximum number of chunks based on a 30 million gas limit.
 * Additionally, we need to reserve a portion of the gas for the cost of the request parameters (which can vary dynamically).
 */
export const MAX_CHUNKS: number = 120;


// Randomly generated fixed hash for testing purposes
export const DUMMY_VERSIONED_COMMITMENT_HASH = '0x01f32ebe6ad26adca597cdb198f041f5d96fc197e3de72e299e86fbf1f5817c8';
