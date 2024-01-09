# Upload EIP4844 Blobs
eip-4844 blobs upload sdk. The sdk is implemented based on c-kzg, so it does not support the browser environment.

## Installation

With [npm](https://npmjs.org) do

```bash
$ npm install ethstorage-sdk
```



### blobs.js
#### EncodeBlobs
Convert files to blobs
```js
const content = fs.readFileSync(filePath);
const blobs = EncodeBlobs(content);
```

#### DecodeBlob
Restore blob to file contents
```js
const data = DecodeBlobs(blobs);
const path = saveFile(data);
```



### uploader.js
Send blob type transaction
```js
const send4844Tx = new Send4844Tx("rpc", "private key");
const hash = await send4844Tx.sendTx(tx, blobs);
```



### download.js
Data is obtained using the eip-5018 standard

```js
interface IERC5018ForBlob {
    function read(bytes memory name) external view returns (bytes memory, bool);
    function countChunks(bytes memory name) external view returns (uint256);
    function readChunk(bytes memory name, uint256 chunkId) external view returns (bytes memory, bool);
    function chunkSize(bytes memory name, uint256 chunkId) external view returns (uint256, bool);
}
```

```js
const data = await DownloadFile("rpc", "contractAddress", "file name");
```



### ethstorage.js
Use this tool to create an ETHStorage storage contract and upload files to the contract.
```js
const ethStorage = new EthStorage("rpc", "private key");
// deploy
await ethStorage.deployBlobDirectory();

...

const ethStorage = new EthStorage("rpc", "private key", "contract address");

// upload
await ethStorage.upload(filePath);
```

### Example
Upload files to the ETH network, See [here](https://github.com/ethstorage/ethstorage-sdk/blob/main/test.js) for details.
```js
const contractAddress = "0x038dB...E8F38F82"
const contractABI = [
    "function writeChunk(bytes memory name) public payable"
]
const provider = new ethers.providers.JsonRpcProvider("https://rpc.dencun-devnet-12.ethpandaops.io/");
// create tx
const contract = new Contract(contractAddress, contractABI, provider);
const tx = await contract.populateTransaction.writeChunk(hexName, {
    value: 100000000
});

...

// read file and create blobs
const content = fs.readFileSync(filePath);
const blobs = EncodeBlobs(content);

...

// send blob
const send4844Tx = new Send4844Tx("https://rpc.dencun-devnet-12.ethpandaops.io/", "private key");
const hash = await send4844Tx.sendTx(tx, blobs);
const txReceipt = await blobUploader.getTxReceipt(hash);
console.log(txReceipt);
```
