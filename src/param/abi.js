
export const EthStorageAbi = [
  'function putBlobs(bytes32[] memory _keys, uint256[] memory _blobIdxs, uint256[] memory _lengths)',
  'function putBlob(bytes32 _key, uint256 _blobIdx, uint256 _length) public payable',
  'function get(bytes32 _key, uint8 _decodeType, uint256 _off, uint256 _len) public view returns (bytes memory)',
  'function size(bytes32 _key) public view returns (uint256)',
  'function upfrontPayment() public view returns (uint256)'
];

export const FlatDirectoryAbi = [
  "constructor(uint8 slotLimit, uint32 maxChunkSize, address storageAddress) public",
  "function version() external view returns (string)",
  "function isSupportBlob() view external returns (bool)",
  "function setDefault(bytes memory _defaultFile) external",
  "function writeChunk(bytes memory name, uint256 chunkId, bytes calldata data) external payable",
  "function writeChunks(bytes memory name, uint256[] memory chunkIds, uint256[] memory sizes) external payable",
  "function remove(bytes memory name) external returns (uint256)",
  "function truncate(bytes memory name, uint256 chunkId) external returns (uint256)",

  'function readChunk(bytes memory name, uint256 chunkId) external view returns (bytes memory, bool)',
  "function upfrontPayment() external view returns (uint256)",
  "function countChunks(bytes memory name) external view returns (uint256)",
  "function getStorageMode(bytes memory name) external view returns(uint256)",
  'function getUploadInfo(bytes memory name) external view returns (uint8 mode, uint256 count, uint256 payment)',
  "function getChunkHash(bytes memory name, uint256 chunkId) external view returns (bytes32)",
  'function getBatchChunkHashes((bytes,uint256[])[] memory fileChunks) external view returns (bytes32[] memory)'
];
