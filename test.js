const {BlobUploader, EncodeBlobs, DecodeBlobs, BLOB_FILE_SIZE} = require("./index");
const {ethers, Contract} = require("ethers");
const fs = require('fs');
const os = require('os');

const stringToHex = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));

async function readFile(contract, name) {
    const result = await contract.read(name);
    return result[0];
}

const saveFile = (data) => {
    console.log(data);
    const exp = new Date();
    const path = `${os.tmpdir()}/${exp.getTime()}`;
    fs.writeFileSync(path, data);
    return path;
}

const filePath = '/Users/lmp/Downloads/WechatIMG4.jpeg';
const name = filePath.substring(filePath.lastIndexOf("/") + 1);
const hexName = stringToHex(name);

const contractAddress = '0x551908F183ADdC623d39e73B48AeDa4E34c3DcA2'
const contractABI = [
    'function read(bytes memory name) public view returns (bytes memory, bool)',
    'function writeChunk(bytes memory name, uint256[] memory chunkIds, uint256[] memory sizes) public payable',
    'function getChunkHash(bytes memory name, uint256 chunkId) public view returns (bytes32)',
    'function upfrontPayment() external view returns (uint256)',
]

async function uploadFile() {
    const provider = new ethers.JsonRpcProvider('http://65.109.115.36:8545/');
    const contract = new Contract(contractAddress, contractABI, provider);
    const blobUploader = new BlobUploader('http://65.109.115.36:8545/', 'private key');

    const content = fs.readFileSync(filePath);
    const blobs = EncodeBlobs(content);
    const blobLength = blobs.length;
    for (let i = 0; i < blobLength; i += 2) {
        const dataHash = await contract.getChunkHash(hexName, i);
        const localHash = blobUploader.getBlobHash(blobs[i]);
        console.log(dataHash === localHash);
        if(dataHash === localHash) {
            continue;
        }

        let blobArr = [];
        let indexArr = [];
        let lenArr = [];
        if (i + 1 < blobLength) {
            blobArr = [blobs[i], blobs[i + 1]];
            indexArr = [i, i + 1];
            lenArr = [BLOB_FILE_SIZE, BLOB_FILE_SIZE];
        } else {
            blobArr = [blobs[i]];
            indexArr = [i];
            lenArr = [BLOB_FILE_SIZE];
        }

        const cost = await contract.upfrontPayment();
        const tx = await contract.writeChunk.populateTransaction(hexName, indexArr, lenArr, {
            value: cost * BigInt(indexArr.length)
        });
        const hash = await blobUploader.sendTx(tx, blobArr);
        console.log(hash);
        const txReceipt = await blobUploader.getTxReceipt(hash);
        console.log(txReceipt);
    }
}

async function read() {
    console.log(hexName);
    const providerRead = new ethers.JsonRpcProvider('http://65.109.63.154:9545');
    const contractRead = new Contract(contractAddress, contractABI, providerRead);
    const blobs = await readFile(contractRead, hexName);
    console.log(blobs.length);

    const data = DecodeBlobs(blobs);
    const path = saveFile(data);
    console.log(path);
}

uploadFile();
// read();
