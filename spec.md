# EthStorage SDK Interface Specification

## Table of Contents

- [1. Introduction](#Introduction)
- [2. Class Overview](#Class_Overview)
- [3. EthStorage Class](#EthStorage)
    - Static Methods
        - create
    - Methods
        - estimateCost
        - read
        - write
        - putBlobs
- [4. FlatDirectory Class](#FlatDirectory)
    - Static Methods
        - create
    - Methods
        - estimateCost
        - estimateFileCost
        - upload
        - uploadFile
        - download
        - deploy
        - setDefault
- [5. Version History](#Version)

---

<p id="Introduction"></p>

## 1. Introduction

This SDK aims to standardize the interaction between applications and the EthStorage network to achieve reliable and efficient data management functionality.

This SDK includes two main classes: `EthStorage` and `FlatDirectory`.
The `EthStorage` class provides asynchronous read and write operations for key-value pairs of a specified size.
The `FlatDirectory` class is a higher-level data management tool that provides methods for uploading and downloading data of arbitrary size.



<p id="Class_Overview"></p>

## 2. Class Overview

### EthStorage Class

| Method Name  | Description                                                    |
|--------------|----------------------------------------------------------------|
| create       | Create an instance of EthStorage                               |
| estimateCost | Estimate the cost of uploading data(gas cost and storage cost) |
| write        | Asynchronously write data                                      |
| read         | Asynchronously read data                                       |
| putBlobs     | Batch upload blob data to the EthStorage network               |

### FlatDirectory Class

| Method Name      | Description                                                    |
|------------------|----------------------------------------------------------------|
| create           | Create an instance of FlatDirectory                            |
| deploy           | Deploy a FlatDirectory contract                                |
| estimateCost     | Estimate the cost of uploading data(gas cost and storage cost) |
| estimateFileCost | Estimate the cost of uploading file(gas cost and storage cost) |
| upload           | Asynchronously upload data of arbitrary size                   |
| uploadFile       | Asynchronously upload file of arbitrary size                   |
| download         | Asynchronously download data                                   |
| setDefault       | Set the default file for FlatDirectory                         |

<p id="EthStorage"></p>

## 3. EthStorage Class

### Static Methods

#### create

**Description**: Create an instance of `EthStorage`.

**Parameters**
- `config` (object): Configuration object containing necessary settings.
    - `rpc` (string): RPC for any evm network.
    - `ethStorageRpc` (string): The EthStorage network rpc corresponding to this evm network, the data is obtained from the EthStorage network.
    - `privateKey` (string): Wallet private key.
    - `address` (string, optional): your Ethstorage contract address if you want to use your own one, if you want to use the default contract address, ignore this.

**Example**
```javascript
const config = {
    rpc: "your_rpc",
    ethStorageRpc: "ethstorage_rpc",
    privateKey: "your_private_key",
    address: "your_contract_address"
};

const ethStorage = await EthStorage.create(config);
```

### Methods

#### estimateCost

**Description**: Estimate the cost of uploading data.

**Parameters**
- `key` (string): The key for the data to be written.
- `data` (Buffer): The data to be written, its size cannot exceed the maximum value of the content that can be transferred by a blob.

**Returns**
- `cost` (Promise<object>): A Promise that resolves to an object containing:
    - `gasCost` (BigInt): The estimated gas cost.
    - `storageCost` (BigInt): The estimated storage cost.

**Example**
```javascript
const cost = await ethStorage.estimateCost("dataKey", Buffer.from("some data"));
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

#### write

**Description**: Asynchronously writes data to the EthStorage network.

**Parameters**
- `key` (string): The key for the data to be written.
- `data` (Buffer): The data to be written, its size cannot exceed the maximum value of the content that can be transferred by a blob.

**Returns**
- `status` (Promise<boolean>): A Promise that resolves to the execution result. `true|false`

**Example**
```javascript
const status = await ethStorage.write("dataKey", Buffer.from("some data"));
```

#### read

**Description**: Read data asynchronously from the EthStorage network through key.

**Parameters**
- `key` (string): The key for the data to be read.

**Returns**
- `data` (Promise<Buffer>): A Promise that resolves to the content.

**Example**
```javascript
const data = await ethStorage.read("example.txt");
```

#### putBlobs
**Description**: Batch upload blob data to the EthStorage network.

**Parameters**
- `number` (number): Number of blobs.
- `data` (Buffer): Blob content to be written.

**Returns**
- `status` (Promise<boolean>): A Promise that resolves to the execution result. `true|false`

**Example**
```javascript
const blobData = Buffer.from("some data");
const status = await ethStorage.putBlobs(number, blobData);
```

<p id="FlatDirectory"></p>

## 4. FlatDirectory Class

### Static Methods

#### create

**Description**: Create an instance of `FlatDirectory`.

**Parameters**
- `config` (object): Configuration object containing necessary settings.
    - `rpc` (string): RPC for any evm network.
    - `ethStorageRpc` (string): The EthStorage network rpc corresponding to this evm network, the data is obtained from the EthStorage network.
    - `privateKey` (string): Wallet private key.
    - `address` (string, optional): FlatDirectory contract address. If it does not exist, the `deploy` method can be called to create one.

**Example**
```javascript
const config = {
    rpc: "your_rpc",
    ethStorageRpc: "ethstorage_rpc",
    privateKey: "your_private_key",
    address: "flat_directory_address"
};

const flatDirectory = await FlatDirectory.create(config);
```

### Methods
#### deploy

**Description**: Deploy a FlatDirectory contract. If the `address` is not set when creating a `FlatDirectory`, you must call deploy before other functions.

**Returns**
- `address` (Promise<string>): A Promise that resolves to the FlatDirectory address.

**Example**
```javascript
const address = await flatDirectory.deploy();
```

#### estimateCost

**Description**: Estimate the cost of uploading data.

**Parameters**
- `key` (string): The key of the data.
- `data` (Buffer): The data to be uploaded.

**Returns**
- `cost` (Promise<object>): A Promise that resolves to an object containing:
    - `gasCost` (BigInt): The estimated gas cost.
    - `storageCost` (BigInt): The estimated storage cost.

**Example**
```javascript
const key = "example1.txt";
const data = Buffer.from("large data to upload");
const cost = await flatDirectory.estimateCost(key, data);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

#### estimateFileCost

**Description**: Estimate the cost of uploading file.

**Parameters**
- `key` (string): The key of the data.
- `file` (File): The file object to upload.

**Returns**
- `cost` (Promise<object>): A Promise that resolves to an object containing:
    - `gasCost` (BigInt): The estimated gas cost.
    - `storageCost` (BigInt): The estimated storage cost.

**Example**
Browser
```javascript
// <input id='fileToUpload' />
const key = "example1.txt";
const file = document.getElementById('fileToUpload').files[0];
const cost = await flatDirectory.estimateFileCost(key, file);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

Node
```javascript
const {NodeFile} = require("ethstorage-sdk/file");
const key = "example1.txt";
const file = new NodeFile("/usr/download/test.jpg");
const cost = await flatDirectory.estimateFileCost(key, file);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

#### upload

**Description**: Upload data of arbitrary size.

**Parameters**
- `key` (string): The key of the data.
- `data` (Buffer): The data to be uploaded.
- `callbacks` (object): An object containing callback functions:
    - `onProgress` (function): Callback function that receives `(progress, count, isChange)`.
    - `onFail` (function): Callback function that receives `(error)`.
    - `onFinish` (function): Callback function that receives `(totalUploadChunks, totalUploadSize, totalStorageCost)`.

**Example**
```javascript
const key = "example1.txt";
const data = Buffer.from("large data to upload");

await flatDirectory.upload(key, data, {
    onProgress: function (progress, count, isChange) {
        console.log(`Uploaded ${progress} of ${count} chunks`);
    },
    onFail: function (error) {
        console.error("Error uploading data:", error);
    },
    onFinish: function (totalUploadChunks, totalUploadSize, totalStorageCost) {
        console.log(`Total upload chunk count is ${totalUploadChunks}, size is ${totalUploadSize}, storage cost is ${totalStorageCost}`);
    }
});
```

#### uploadFile

**Description**: Upload file object of arbitrary size.

**Parameters**
- `key` (string): The key of the data.
- `file` (File): The file object to be uploaded.
- `callbacks` (object): An object containing callback functions:
    - `onProgress` (function): Callback function that receives `(progress, count, isChange)`.
    - `onFail` (function): Callback function that receives `(error)`.
    - `onFinish` (function): Callback function that receives `(totalUploadChunks, totalUploadSize, totalStorageCost)`.

**Example**
Browser
```javascript
// <input id='fileToUpload' />
const file = document.getElementById('fileToUpload').files[0];
await flatDirectory.uploadFile("example1.txt", file, {
    onProgress: function (progress, count, isChange) {
        console.log(`Uploaded ${progress} of ${count} chunks`);
    },
    onFail: function (error) {
        console.error("Error uploading data:", error);
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
await flatDirectory.uploadFile("example1.txt", file, {
    onProgress: function (progress, count, isChange) {
        console.log(`Uploaded ${progress} of ${count} chunks`);
    },
    onFail: function (error) {
        console.error("Error uploading data:", error);
    },
    onFinish: function (totalUploadChunks, totalUploadSize, totalStorageCost) {
        console.log(`Total upload chunk count is ${totalUploadChunks}, size is ${totalUploadSize}, storage cost is ${totalStorageCost}`);
    }
});
```

#### download

**Description**: Asynchronously download data by key. Get the progress and data in the callback function.

**Parameters**
- `key` (string): The key for the data to be read.
- `callbacks` (object): An object containing callback functions:
    - `onProgress` (function): Callback function that receives `(progress, count, chunk)`.
    - `onFail` (function): Callback function that receives `(error)`.
    - `onFinish` (function): Indicates that the upload was finish.

**Example**
```javascript
flatDirectory.download("example.txt", {
    onProgress: function (progress, count, chunk) {
        console.log(`Download ${progress} of ${count} chunks, this chunk is ${chunk.toString()}`);
    },
    onFail: function (error) {
        console.error("Error download data:", error);
    },
    onFinish: function () {
        console.log("Download finish.");
    }
});
```


#### setDefault

**Description**: Set the default file for FlatDirectory, the file that is accessed by default when no file name is provided.

**Parameters**
- `defaultFile` (string): The filename of the default file.

**Returns**
- `status` (Promise<boolean>): A Promise that resolves to the execution result. `true|false`

**Example**
```javascript
const defaultFile = "index.html";
const status = await flatDirectory.setDefault(defaultFile);
```

<p id="Version"></p>

## 5. Version History

- v1.0.1: Initial release with basic storage and data management functionalities.

