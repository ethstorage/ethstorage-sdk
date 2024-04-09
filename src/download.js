import {ethers, Contract} from "ethers";

const contractABI = [
    'function countChunks(bytes memory name) external view returns (uint256)',
    'function readChunk(bytes memory name, uint256 chunkId) external view returns (bytes memory, bool)'
]

const stringToHex = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));

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
    const hexName = stringToHex(fileName);

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

module.exports = {
    DownloadFile
}
