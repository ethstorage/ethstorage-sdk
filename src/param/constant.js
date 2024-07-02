
const SEPOLIA_CHAIN_ID = 11155111;
const QUARKCHAIN_L2_CHAIN_ID = 42069;

export const ETHSTORAGE_MAPPING = {
    [SEPOLIA_CHAIN_ID]: '0x804C520d3c084C805E37A35E90057Ac32831F96f',
    [QUARKCHAIN_L2_CHAIN_ID]: '0x90a708C0dca081ca48a9851a8A326775155f87Fd',
}



const BlobTxBytesPerFieldElement         = 32;      // Size in bytes of a field element
const BlobTxFieldElementsPerBlob         = 4096;
export const BLOB_SIZE = BlobTxBytesPerFieldElement * BlobTxFieldElementsPerBlob;
export const BLOB_DATA_SIZE = 31 * BlobTxFieldElementsPerBlob;

// DecodeType
export const RawData = 0;
export const PaddingPer31Bytes = 1;



export const MAX_BLOB_COUNT = 3;