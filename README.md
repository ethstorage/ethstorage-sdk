# ethstorage-sdk

This SDK aims to standardize the interaction between applications and the EthStorage network to achieve reliable and
efficient data management functionality.

This SDK includes two classes: `EthStorage` and `FlatDirectory`.
The `EthStorage` class provides asynchronous read and write operations for key-value pairs of a specified size.
The `FlatDirectory` class is a higher-level data management tool that provides methods for uploading and downloading
data of arbitrary size.

Click here to view [spec](https://github.com/ethstorage/ethstorage-sdk/sepc.md).

## Installation

With [npm](https://www.npmjs.com/package/ethstorage-sdk) do

```bash
$ npm install ethstorage-sdk
```

## Example

### EthStorage

#### create

Create EthStorage SDK.

```js
const {EthStorage} = require("ethstorage-sdk")

const rpc = "https://1rpc.io/sepolia";
const ethStorageRpc = "http://65.109.115.36:9540";
const privateKey = "0xabcd...";

const ethStorage = await EthStorage.create({
    rpc: rpc,
    ethStorageRpc: ethStorageRpc,
    privateKey: privateKey,
});
```

If you want to use your own contract, you can specify your contract address when create EthStorage.
```js
const {EthStorage} = require("ethstorage-sdk")

const rpc = "https://1rpc.io/sepolia";
const ethStorageRpc = "http://65.109.115.36:9540";
const privateKey = "0xabcd...";
const address = "0xabcd..."; // EthStorage contract address

const ethStorage = await EthStorage.create({
    rpc: rpc,
    ethStorageRpc: ethStorageRpc,
    privateKey: privateKey,
    address: address,
});
```

#### estimateCost

Estimate gas costs before uploading.

```js
const key = "example1.txt";
const data = Buffer.from("large data to upload");

const cost = await ethStorage.estimateCost(key, data);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

#### write

Write blob data to EthStorage network.

```js
const key = "test.txt";
const data = Buffer.from("test data");
await ethStorage.write(key, data);
```


#### read

Read written data from the EthStorage network.

```js
const key = "test.txt";
const data = await ethStorage.read(key);
```

#### putBlobs

Batch upload blob data.

```js
const keys = ["key1", "key2"];
const data = [Buffer.from("some data"), Buffer.from("test data")];
const status = await ethStorage.putBlobs(keys, data);
```



### FlatDirectory

#### create

Create FlatDirectory SDK.

```js
const {FlatDirectory} = require("ethstorage-sdk")

const rpc = "https://1rpc.io/sepolia";
const ethStorageRpc = "http://65.109.115.36:9540";
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

#### deploy

Deploy the implementation
contract [FlatDirectory](https://github.com/ethstorage/evm-large-storage/blob/master/contracts/examples/FlatDirectory.sol)
for [EIP-5018](https://eips.ethereum.org/EIPS/eip-5018) standard.

```js
const contracAddress = await flatDirectory.deploy();
console.log(`FlatDirectory address is ${contracAddress}.`);
```

#### estimateCost

Estimate gas costs before uploading.

```js
const key = "example1.txt";
const data = Buffer.from("large data to upload");

const cost = await flatDirectory.estimateCost(key, data);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

#### estimateFileCost

Estimate gas costs before uploading.

Browser
```javascript
// <input id='fileToUpload' />
const file = document.getElementById('fileToUpload').files[0];
const cost = await flatDirectory.estimateFileCost("example1.txt", file);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

Node
```javascript
const {NodeFile} = require("ethstorage-sdk/file");
const file = new NodeFile("/usr/download/test.jpg");
const cost = await flatDirectory.estimateFileCost("example1.txt", file);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

#### upload

Upload data to FlatDirectory.

```js
const key = "test.txt";
const filePath = "/users/dist/test.txt";
const data = fs.readFileSync(filePath);

await flatDirectory.upload(key, data);
```

If you want to listener the upload results, you can pass in the callback function.

```js
await flatDirectory.upload(key, data, {
    onProgress: function (progress, count, isChange) {
        console.log(`Uploaded ${progress} of ${count} chunks`);
    },
    onFail: function (err) {
        console.log(err);
    },
    onFinish: function (totalUploadChunks, totalUploadSize, totalStorageCost) {
        console.log(`Total upload chunk count is ${totalUploadChunks}, size is ${totalUploadSize}, storage cost is ${totalStorageCost}`);
    }
});
```

#### uploadFile

Upload file object to FlatDirectory.

Browser
```javascript
// <input id='fileToUpload' />
const file = document.getElementById('fileToUpload').files[0];
await flatDirectory.uploadFile(key, file, {
    onProgress: function (progress, count, isChange) {
        console.log(`Uploaded ${progress} of ${count} chunks`);
    },
    onFail: function (err) {
        console.log(err);
    },
    onFinish: function (totalUploadChunks, totalUploadSize, totalStorageCost) {
        console.log(`Total upload chunk count is ${totalUploadChunks}, size is ${totalUploadSize}, storage cost is ${totalStorageCost}`);
    }
});
```

Node
```javascript
const {NodeFile} = require("ethstorage-sdk/file");
const file = new NodeFile("/usr/download/test.jpg");
await flatDirectory.uploadFile(key, file, {
    onProgress: function (progress, count, isChange) {
        console.log(`Uploaded ${progress} of ${count} chunks`);
    },
    onFail: function (err) {
        console.log(err);
    },
    onFinish: function (totalUploadChunks, totalUploadSize, totalStorageCost) {
        console.log(`Total upload chunk count is ${totalUploadChunks}, size is ${totalUploadSize}, storage cost is ${totalStorageCost}`);
    }
});
```


#### download

If you want to listener the download progress, you can pass in the callback function.

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
