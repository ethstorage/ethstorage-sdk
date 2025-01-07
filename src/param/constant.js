
const SEPOLIA_CHAIN_ID = 11155111;
const QUARKCHAIN_L2_DEVNET_CHAIN_ID = 42069;
const QUARKCHAIN_L2_TESTNET_CHAIN_ID = 3335;

export const ETHSTORAGE_MAPPING = {
    [SEPOLIA_CHAIN_ID]: '0x804C520d3c084C805E37A35E90057Ac32831F96f',
    [QUARKCHAIN_L2_DEVNET_CHAIN_ID]: '0x90a708C0dca081ca48a9851a8A326775155f87Fd',
    [QUARKCHAIN_L2_TESTNET_CHAIN_ID]: '0x64003adbdf3014f7E38FC6BE752EB047b95da89A',
}



const BlobTxBytesPerFieldElement         = 32;      // Size in bytes of a field element
const BlobTxFieldElementsPerBlob         = 4096;
export const BLOB_SIZE = BlobTxBytesPerFieldElement * BlobTxFieldElementsPerBlob;
export const BLOB_DATA_SIZE = 31 * BlobTxFieldElementsPerBlob;

export const OP_BLOB_DATA_SIZE = (4 * 31 + 3) * 1024 - 4;


// DecodeType
export const RawData = 0;
export const PaddingPer31Bytes = 1;
export const OptimismCompact = 2;

export const BLOB_COUNT_LIMIT = 6;
export const MAX_BLOB_COUNT = 3;


export const UPLOAD_TYPE_CALLDATA = 1;
export const UPLOAD_TYPE_BLOB = 2;


export const MAX_RETRIES = 3;

/**
 * eth_call consumes gas, so we need to estimate the maximum number of chunks based on a 30 million gas limit.
 * Additionally, we need to reserve a portion of the gas for the cost of the request parameters (which can vary dynamically).
 */
export const MAX_CHUNKS = 120;
