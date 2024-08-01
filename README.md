# ethstorage-sdk

This SDK aims to standardize the interaction between applications and the EthStorage network to achieve reliable and
efficient data management functionality.

This SDK includes two classes: `EthStorage` and `FlatDirectory`.
The `EthStorage` class provides asynchronous read and write operations for key-value pairs of a specified size.
The `FlatDirectory` class is a higher-level data management tool that provides methods for uploading and downloading
data of arbitrary size.

Click here to view [spec](https://github.com/ethstorage/ethstorage-sdk/sepc.md).

# Installation

Install the SDK using [npm](https://www.npmjs.com/package/ethstorage-sdk):

```bash
$ npm install ethstorage-sdk
```

# Example Usage

## EthStorage

### create

Create an `EthStorage` instance.

```js
const { EthStorage } = require("ethstorage-sdk");

const rpc = "https://rpc.testnet.l2.quarkchain.io:8545";
const ethStorageRpc = "https://rpc.testnet.l2.ethstorage.io:9540";
const privateKey = "0xabcd...";

const ethStorage = await EthStorage.create({
    rpc: rpc,
    ethStorageRpc: ethStorageRpc,
    privateKey: privateKey,
});
```

### write

Write blob data to the EthStorage network.

```js
const key = "test.txt";
const data = Buffer.from("test data");
await ethStorage.write(key, data);
```

### read

Read written data from the EthStorage network.

```js
const key = "test.txt";
const data = await ethStorage.read(key);
```

### writeBlobs

Batch upload blob data.

```js
const keys = ["key1", "key2"];
const dataBlobs = [Buffer.from("some data"), Buffer.from("test data")];
const status = await ethStorage.writeBlobs(keys, dataBlobs);
```

### estimateCost

Estimate gas costs before uploading.

```js
const key = "example1.txt";
const data = Buffer.from("large data to upload");

const cost = await ethStorage.estimateCost(key, data);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```


## FlatDirectory

### create

Create a `FlatDirectory` instance.

```js
const { FlatDirectory } = require("ethstorage-sdk");

const rpc = "https://rpc.testnet.l2.quarkchain.io:8545";
const ethStorageRpc = "https://rpc.testnet.l2.ethstorage.io:9540";
const privateKey = "0xabcd...";

const flatDirectory = await FlatDirectory.create({
    rpc: rpc,
    ethStorageRpc: ethStorageRpc,
    privateKey: privateKey,
});
```

If FlatDirectory has been deployed, it can be set through the 'address' field.

```js
const address = "0x987..."; // FlatDirectory address
const flatDirectory = await FlatDirectory.create({
    rpc: rpc,
    ethStorageRpc: ethStorageRpc,
    privateKey: privateKey,
    address: address,
});
```

### deploy

Deploy the implementation
contract [FlatDirectory](https://github.com/ethstorage/evm-large-storage/blob/master/contracts/examples/FlatDirectory.sol)
for [EIP-5018](https://eips.ethereum.org/EIPS/eip-5018) standard.

```js
const contracAddress = await flatDirectory.deploy();
console.log(`FlatDirectory address is ${contracAddress}.`);
```

### upload

Upload `buffer | file` to the FlatDirectory.

```js
const callback = {
    onProgress: function (progress, count, isChange) {
        console.log(`Uploaded ${progress} of ${count} chunks`);
    },
    onFail: function (err) {
        console.log(err);
    },
    onFinish: function (totalUploadChunks, totalUploadSize, totalStorageCost) {
        console.log(`Total upload chunk count is ${totalUploadChunks}, size is ${totalUploadSize}, storage cost is ${totalStorageCost}`);
    }
};

const request = {
    key: "test.txt",
    content: Buffer.from("big data"),
    type: 2, // blob
    callback: callback
}
await flatDirectory.upload(request);
```

If you want to use `file`, it can be divided into browser and Node.js.

Browser
```javascript
// <input id='fileToUpload' />
const file = document.getElementById('fileToUpload').files[0];

const request = {
    key: "test.txt",
    content: file,
    type: 1, // calldata
    callback: callback
}
await flatDirectory.upload(request);
```

Node.js
```javascript
const {NodeFile} = require("ethstorage-sdk/file");
const file = new NodeFile("/usr/download/test.jpg");

const request = {
    key: "test.txt",
    content: file,
    type: 2, // blob
    callback: callback
}
await flatDirectory.upload(request);
```

### download

Monitor the download progress by passing in a callback function.

```js
const key = "test.txt";
await flatDirectory.download(key, {
    onProgress: function (progress, count, chunk) {
        console.log(`Download ${progress} of ${count} chunks, this chunk is ${chunk.toString()}`);
    },
    onFail: function (error) {
        console.error("Error download data:", error);
    },
    onFinish: function () {
        console.log("Download success.");
    }
});
```

### estimateCost

Estimate gas costs before uploading.

```js
const request = {
    key: "example1.txt",
    content: Buffer.from("large data to upload"),
    type: 2
}

const cost = await flatDirectory.estimateCost(request);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

Use `file`.

Browser
```javascript
// <input id='fileToUpload' />
const file = document.getElementById('fileToUpload').files[0];

const request = {
    key: "example1.txt",
    content: file,
    type: 2 // calldata
}
const cost = await flatDirectory.estimateCost(request);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

Node.js
```javascript
const {NodeFile} = require("ethstorage-sdk/file");
const file = new NodeFile("/usr/download/test.jpg");

const request = {
    key: "example1.txt",
    content: file,
    type: 1 // blob
}
const cost = await flatDirectory.estimateCost(request);
```
