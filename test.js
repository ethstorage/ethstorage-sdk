const {BlobUploader, EncodeBlobs, BLOB_FILE_SIZE, DownloadFile, EthStorage} = require("./index");
const {ethers, Contract} = require("ethers");
const fs = require('fs');
const os = require('os');

const dotenv = require("dotenv")
dotenv.config()
const privateKey = process.env.pk;

const stringToHex = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));

const filePath = '/Users/lmp/Downloads/dist/img2.jpeg';
const name = filePath.substring(filePath.lastIndexOf("/") + 1);
const hexName = stringToHex(name);

const contractAddress = '0xd45D0B713138b24291b675aeE0e2F6776fCb173b'
const contractABI = [
    'function read(bytes memory name) public view returns (bytes memory, bool)',
    'function writeChunks(bytes memory name, uint256[] memory chunkIds, uint256[] memory sizes) public payable',
    'function getChunkHash(bytes memory name, uint256 chunkId) public view returns (bytes32)',
    'function upfrontPayment() external view returns (uint256)',
]

async function uploadFile() {
    const provider = new ethers.JsonRpcProvider('http://65.109.115.36:8545/');
    const contract = new Contract(contractAddress, contractABI, provider);
    const blobUploader = new BlobUploader('http://65.109.115.36:8545/', privateKey);

    const content = fs.readFileSync(filePath);
    const blobs = EncodeBlobs(content);
    const blobLength = blobs.length;
    for (let i = 0; i < blobLength; i += 2) {
        const dataHash = await contract.getChunkHash(hexName, i);
        const localHash = await blobUploader.getBlobHash(blobs[i]);
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
            lenArr = [content.length];
        }

        const cost = await contract.upfrontPayment();
        const tx = await contract.writeChunks.populateTransaction(hexName, indexArr, lenArr, {
            value: cost * BigInt(indexArr.length)
        });
        const hash = await blobUploader.sendTx(tx, blobArr);
        console.log(hash);
        const txReceipt = await blobUploader.getTxReceipt(hash);
        console.log(txReceipt);
    }
}

const saveFile = (data) => {
    const exp = new Date();
    const path = `${os.tmpdir()}/${exp.getTime()}`;
    fs.writeFileSync(path, data);
    return path;
}

async function read() {
    const data = await DownloadFile('http://88.99.30.186:9545', contractAddress, "2022.jpeg");
    const path = saveFile(data);
    console.log(path);
}

// uploadFile();
// read();

async function ethStorageTest() {
    const ethStorage = new EthStorage('http://88.99.30.186:8545/', privateKey, "0xdEE635d1fE680462C62E51037552952dBAF5aD3d");
    // await ethStorage.deploySepoliaDirectory();
    await ethStorage.upload(filePath);
    const buff = await ethStorage.download(name);
    const p = saveFile(buff)
    console.log(p)
}
ethStorageTest();
