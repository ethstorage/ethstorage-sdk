# ethstorage-sdk
Tool for uploading and downloading data for EthStorage network, utilizing the [EIP-5018](https://eips.ethereum.org/EIPS/eip-5018) standard for data.

## Installation

With [npm](https://www.npmjs.com/package/ethstorage-sdk) do

```bash
$ npm install ethstorage-sdk
```

## Example

### Constructor

Init SDK.
```js
const { EthStorage } = require("ethstorage-sdk")

const rpc = "https://rpc.sepolia.org";
const privateKey =  "0xabcd...";

const ethStorage = new EthStorage(rpc, privateKey);
```

### Deploy

Deploy the implementation contract [FlatDirectory](https://github.com/ethstorage/evm-large-storage/blob/master/contracts/examples/FlatDirectory.sol) for EIP-5018 standard.
```js
// EthStorage Contract is the contract address where EthStorage is deployed on Layer 1.
const ethStorageContract = "0x804C520d3c084C805E37A35E90057Ac32831F96f";

await ethStorage.deploy(ethStorageContract);
```

Sepolia network can invoke the following methods:
```js
await ethStorage.deploySepolia();
```

If FlatDirectory has already been deployed, you can set it.
```js
const rpc = "https://rpc.sepolia.org";
const privateKey =  "0xabcd...";
const flatDirectory = "0xdcba...";

const ethStorage = new EthStorage(rpc, privateKey, flatDirectory);
```

### Upload
Upload files to FlatDirectory.

You can set the file or folder path, and if it is a browser environment, you can also set the file object.
```js
const fileOrPath = "/users/dist/test.txt";

await ethStorage.upload(fileOrPath);
```

If you want to upload data, use 'uploadData'
```js
const fileName = "test.txt";
const filePath = "/users/dist/test.txt";
const data = fs.readFileSync(filePath);

await ethStorage.uploadData(fileName, data);
```

### Download
Download data from the EthStorage network.
```js
// Since the data is downloaded from ethstorage, the provided RPC should be an ethstorage RPC.
const ethStorageRpc = "https://ethstorage.rpc.io";
const fileName = "test.txt";

const data = await ethStorage.download(fileName, ethStorageRpc);
```

or

```js
// Since the data is downloaded from ethstorage, the provided RPC should be an ethstorage RPC.
const { Download } = require("ethstorage-sdk")

const flatDirectory = "0xdcba...";
const ethStorageRpc = "https://ethstorage.rpc.io";
const fileName = "test.txt";

const data = await Download(ethStorageRpc, flatDirectory, fileName);
```
