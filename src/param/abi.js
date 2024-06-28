
export const EthStorageAbi = [
  'function putBlobs(uint256 num) public payable',
  'function putBlob(bytes32 _key, uint256 _blobIdx, uint256 _length) public payable',
  'function get(bytes32 _key, uint8 _decodeType, uint256 _off, uint256 _len) public view returns (bytes memory)',
  'function size(bytes32 _key) public view returns (uint256)',
  'function upfrontPayment() public view returns (uint256)'
];

export const FlatDirectoryAbi = [
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
