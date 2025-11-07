# EthStorage SDK Interface Specification

# Table of Contents

- [1. Introduction](#Introduction)
- [2. Class Overview](#Class_Overview)
- [3. EthStorage Class](#EthStorage)
    - Static Methods
        - create
    - Methods
        - estimateCost
        - read
        - write
        - writeBlobs
- [4. FlatDirectory Class](#FlatDirectory)
    - Static Methods
        - create
    - Methods
        - deploy
        - estimateCost
        - upload
        - download
        - fetchHashes
        - setDefault
- [5. Version History](#Version)

---

<p id="Introduction"></p>

# 1. Introduction

This SDK aims to standardize the interaction between applications and the EthStorage network to achieve reliable and
efficient data management functionality.

This SDK includes two main classes: `EthStorage` and `FlatDirectory`.
The `EthStorage` class provides asynchronous read and write operations for key-value pairs of a specified size.
The `FlatDirectory` class is a higher-level data management tool that provides methods for uploading and downloading
data of arbitrary size.



<p id="Class_Overview"></p>

# 2. Class Overview

## EthStorage Class

| Method Name  | Description                                                    |
|--------------|----------------------------------------------------------------|
| create       | Create an instance of EthStorage                               |
| estimateCost | Estimate the cost of uploading data(gas cost and storage cost) |
| write        | Asynchronously write data                                      |
| read         | Asynchronously read data                                       |
| writeBlobs   | Batch upload blob data to the EthStorage network               |
| close        | Release resources used by the EthStorage instance              |

## FlatDirectory Class

| Method Name  | Description                                                    |
|--------------|----------------------------------------------------------------|
| create       | Create an instance of FlatDirectory                            |
| deploy       | Deploy a FlatDirectory contract                                |
| estimateCost | Estimate the cost of uploading data(gas cost and storage cost) |
| upload       | Asynchronously upload data of arbitrary size                   |
| download     | Asynchronously download data                                   |
| fetchHashes  | Get chunk hashes of data in batches                            |
| setDefault   | Set the default file for FlatDirectory                         |
| close        | Release resources used by the FlatDirectory instance           |

<p id="EthStorage"></p>

# 3. EthStorage Class

## Static Methods

### create

**Description**: Create an instance of `EthStorage`.

**Parameters**
- `config` (object): Configuration object containing necessary settings.
    - `rpc` (string, optional): RPC for any evm network.
    - `ethStorageRpc` (string, optional): The EthStorage network rpc corresponding to this evm network, the data is obtained from
      the EthStorage network.
    - `privateKey` (string, optional): Wallet private key.
    - `address` (string, optional): your Ethstorage contract address if you want to use your own one, if you want to use
      the default contract address, ignore this.

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

## Methods

### estimateCost

**Description**: Estimate the cost of uploading data.

**Parameters**
- `key` (string): The key for the data to be written.
- `data` (Buffer): The data to be written, its size cannot exceed the maximum value of the content that can be
  transferred by a blob.

**Returns**
- `cost` (`Promise<object>`): A Promise that resolves to an object containing:
    - `gasCost` (BigInt): The estimated gas cost.
    - `storageCost` (BigInt): The estimated storage cost.

**Example**
```javascript
const cost = await ethStorage.estimateCost("dataKey", Buffer.from("some data"));
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

### write

**Description**: Asynchronously writes data to the EthStorage network.

**Parameters**
- `key` (string): The key for the data to be written.
- `data` (Buffer): The data to be written, its size cannot exceed the maximum value of the content that can be
  transferred by a blob.

**Returns**
- `result` (Promise<{ hexKey: string, success: boolean }>): A Promise that resolves to an object containing:
  - `hash` (string): The transaction hash of the write operation.
  - `success` (boolean): The execution result (true if the transaction was successful, otherwise false).

**Example**
```javascript
const result = await ethStorage.write("dataKey", Buffer.from("some data"));
```

### read

**Description**: Read data asynchronously from the EthStorage network through key.

**Parameters**
- `key` (string): The key for the data to be read.
- `decodeType` (DecodeType, optional): The decoding mode for blob data. The default is DecodeType.OptimismCompact.
- `address` (string, required in read-only mode): The wallet address that uploaded the data. This parameter is required
  in read-only mode.

**Returns**
- `data` (Promise<Buffer>): A Promise that resolves to the content.

**Example**
```javascript
const data = await ethStorage.read("example.txt");
```

### writeBlobs
**Description**: Batch upload blob data to the EthStorage network.

**Parameters**
- `keys` (string[]): Array of strings representing the keys for the blobs.
- `dataBlobs` (Buffer[]): Array of Buffers containing the blob content to be written. Each Buffer's size must not exceed
  the corresponding blob size.

**Returns**
- `result` (Promise<{ hexKeys: string[], success: boolean }>): A Promise that resolves to an object containing:
  - `hash` (string): The transaction hash of the write operation.
  - `success` (boolean): The execution result (true if all blobs were uploaded successfully, otherwise false).

**Example**
```javascript
const keys = ["key1", "key2", "key3"];
const dataBlobs = [Buffer.from("test data 1"), Buffer.from("test data 2"), Buffer.from("test data 3")];
const result = await ethStorage.writeBlobs(keys, dataBlobs);
```

### close
**Description**: Release resources used by the EthStorage instance.

**Parameters**  
_None_

**Returns**
- `result` (Promise<void>): A Promise that resolves when the instance is successfully closed.

**Example**
```javascript
await ethStorage.close();
```

<p id="FlatDirectory"></p>

# 4. FlatDirectory Class

## Static Methods

### create

**Description**: Create an instance of `FlatDirectory`.

**Parameters**
- `config` (object): Configuration object containing necessary settings.
    - `rpc` (string): RPC for any evm network.
    - `ethStorageRpc` (string): The EthStorage network rpc corresponding to this evm network, the data is obtained from
      the EthStorage network.
    - `privateKey` (string): Wallet private key.
    - `address` (string, optional): FlatDirectory contract address. If it does not exist, the `deploy` method can be
      called to create one.

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

## Methods

### deploy

**Description**: Deploy a FlatDirectory contract. If the `address` is not set when creating a `FlatDirectory`, you must
call deploy before other functions.

**Returns**
- `address` (Promise<string>): A Promise that resolves to the FlatDirectory address.

**Example**
```javascript
const address = await flatDirectory.deploy();
```

### estimateCost

**Description**: Estimate the cost of uploading data|file.

**Parameters**
- `request` (object): Configuration the upload object containing necessary settings.
    - `key` (string): The key of the data.
    - `type` (number): File upload mode, 1 for calldata, 2 for blob
    - `content` (Buffer|File, optional): The content to be uploaded, which can be either a Buffer or a File.
    - `chunkHashes` (string[], optional): The chunk hashes corresponding to the content. If this parameter exists, no request to retrieve the hashes will be triggered.
    - `gasIncPct` (number, optional): The parameter is used to specify the percentage increase on the current default
      gas. For example, if the current default gas is 100 gwei and `gasIncPct` is set to 20, then the final gas will be 120
      gwei.

**Returns**
- `cost` (`Promise<object>`): A Promise that resolves to an object containing:
    - `gasCost` (BigInt): The estimated gas cost.
    - `storageCost` (BigInt): The estimated storage cost.

**Example**
```javascript
const request = {
    key: "example1.txt",
    gasIncPct: 20, // add 20%
    type: 2,
    content: Buffer.from("large data to upload")
}
const cost = await flatDirectory.estimateCost(request);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

If you want to use `file`, it can be divided into browser and Node.js.

Browser
```javascript
// <input id='fileToUpload' />
const file = document.getElementById('fileToUpload').files[0];

const request = {
    key: "example1.txt",
    content: file,
    type: 1
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
    type: 2
}
const cost = await flatDirectory.estimateCost(request);
console.log(`Gas Cost: ${cost.gasCost}, Storage Cost: ${cost.storageCost}`);
```

### upload

**Description**: Upload data of arbitrary size.

**Parameters**
- `request` (object): Configuration the upload object containing necessary settings.
    - `key` (string): The key of the data.
    - `type` (number): File upload mode, 1 for calldata, 2 for blob
    - `content` (Buffer|File): The content to be uploaded, which can be either a Buffer or a File.
    - `chunkHashes` (string[], optional): The chunk hashes corresponding to the content. If this parameter exists, no
      request to retrieve the hashes will be triggered.
    - `gasIncPct` (number, optional): The parameter is used to specify the percentage increase on the current default
      gas. For example, if the current default gas is 100 gwei and `gasIncPct` is set to 20, then the final gas will be
      120 gwei.
    - `callback` (object): An object containing callback functions:
        - `onProgress(currentChunk, totalChunks, isChange)` (function): Called during the upload process to track progress.
            - **`currentChunk`** (number): The index of the currently uploading chunk.
            - **`totalChunks`** (number): The total number of chunks to be uploaded.
            - **`isChange`** (boolean): Indicates whether the content has changed.
        - `onFail(error)` (function): Called when an error occurs during the upload process.
            - **`error`** (Error): The error object describing the failure.
        - `onFinish(totalUploadChunks, totalUploadSize, totalCost)` (function): Called when the upload is completed.
            - **`totalUploadChunks`** (number): The total number of uploaded chunks.
            - **`totalUploadSize`** (number): The total uploaded size (in bytes).
            - **`totalCost`** (bigint): The total cost of the upload, including **storage cost**, **gas cost**, and **blob gas cost**.

**Example**
```javascript
const cb = {
    onProgress: function (progress, count, isChange) {
        console.log(`Uploaded ${progress} of ${count} chunks`);
    },
    onFail: function (error) {
        console.error("Error uploading data:", error);
    },
    onFinish: function (totalUploadChunks, totalUploadSize, totalCost) {
        console.log(`Total upload chunk count is ${totalUploadChunks}, size is ${totalUploadSize}, total cost is ${totalCost}`);
    }
};
const request = {
    key: "example1.txt",
    gasIncPct: 30, // add 40%
    content: Buffer.from("large data to upload"),
    type: 2,
    callback: cb
}
await flatDirectory.upload(request);
```

Use `file`.

Browser
```javascript
// <input id='fileToUpload' />
const file = document.getElementById('fileToUpload').files[0];

const request = {
    key: "example1.txt",
    gasIncPct: 30, // add 40%
    content: file,
    type: 1,
    callback: cb
}
await flatDirectory.upload(request);
```

Node.js
```javascript
const {NodeFile} = require("ethstorage-sdk/file");
const file = new NodeFile("/usr/download/test.jpg");

const request = {
    key: "example1.txt",
    gasIncPct: 30, // add 40%
    content: file,
    type: 2,
    callback: cb
}
await flatDirectory.upload(request);
```

### download

**Description**: Asynchronously download data by key. Get the progress and data in the callback function.

**Parameters**
- `key` (string): The key for the data to be read.
- `callback` (object): An object containing callback functions:
    - `onProgress(currentChunk, totalChunks, chunkData)` (function): Called during the download process to track progress and receive chunk data.
      - **`currentChunk`** (number): The index of the currently downloading chunk.
      - **`totalChunks`** (number): The total number of chunks to be downloaded.
      - **`chunkData`** (Uint8Array): The binary data of the current chunk.
    - `onFail(error)` (function): Called when an error occurs during the download process.
      - **`error`** (Error): The error object describing the failure.
    - `onFinish()` (function): Indicates that the upload was finish.

**Example**
```javascript
flatDirectory.download("example.txt", {
    onProgress: function (firstChunkId, totalChunks, data, actualChunkCount) {
        console.log(`Download ${firstChunkId} of ${totalChunks} chunks, this chunk is ${Buffer.from(data).toString()}`);
    },
    onFail: function (error) {
        console.error("Error download data:", error);
    },
    onFinish: function () {
        console.log("Download finish.");
    }
});
```

### fetchHashes

**Description**: Retrieve the chunk hashes corresponding to the batch of keys.

**Parameters**
- `keys` (string[]): The keys to be retrieved.

**Returns**
- `result` (Promise<Record<string, string[]>>): A Promise that resolves to an object where each key (from the input keys) maps to an array of chunk hashes.

**Example**
```javascript
const keys = ["key1", "key2"];
const result = await flatDirectory.fetchHashes(keys);
```

### setDefault

**Description**: Set the default file for FlatDirectory, the file that is accessed by default when no file name is
provided.

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

### close
**Description**: Release resources used by the FlatDirectory instance.

**Parameters**  
_None_

**Returns**
- `result` (Promise<void>): A Promise that resolves when the instance is successfully closed.

**Example**
```javascript
await flatDirectory.close();
```

# 5. Version History

- v1.1.1: Initial release with basic storage and data management functionalities.

