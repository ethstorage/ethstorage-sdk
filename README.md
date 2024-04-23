# ethstorage-sdk
Tool for uploading and downloading data for EthStorage network, utilizing the [EIP-5018](https://eips.ethereum.org/EIPS/eip-5018) standard for data.

## Installation

With [npm](https://www.npmjs.com/package/ethstorage-sdk) do

```bash
$ npm install ethstorage-sdk
```

## Example

### Constructor
Init ethstorage-sdk.
```js
const { EthStorage } = require("ethstorage-sdk")

const ethStorage = new EthStorage(rpc, privateKey);

or

const ethStorage = new EthStorage(rpc, privateKey, flatDirectoryAddress);
```

### Deploy
Deploy the implementation contract of the eip-5018 standard [FlatDirectory](https://github.com/ethstorage/evm-large-storage/blob/master/contracts/examples/SimpleFlatDirectory.sol).
```js
// ethStorageContract is the contract address of ETHstorage deployed on L1. 
await ethStorage.deploy(ethStorageContract);

// Sepolia integrates this address internally
await ethStorage.deploySepolia();
```

### Upload
Upload files to [FlatDirectory](https://github.com/ethstorage/evm-large-storage/blob/master/contracts/examples/SimpleFlatDirectory.sol).
```js
// Pass the file path or file selected via browser folder.
await ethStorage.upload(fileOrPath);

or

const data = fs.readFileSync(filePath);
await ethStorage.uploadData(fileName, data);
```


### Download
Download uploaded data from the EthStorage network.
```js
// Since the data is downloaded from ethstorage, the provided RPC should be an ethstorage RPC.
const data = await ethStorage.download(fileName, ethStorageRpc);

or

const { Download } = require("ethstorage-sdk")
const data = await Download(ethstorageRpc, flatDirectoryAddress, fileName);
```
