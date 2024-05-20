
# EthStorage SDK Interface Specification

## Table of Contents

- [1. Introduction](#Introduction)
- [2. Terminology](#Terminology)
- [3. Class Overview](#Class_Overview)
- [4. EthStorage Class](#EthStorage)
    - Constructor
    - Methods
        - read
        - write
- [5. FlatDirectory Class](#FlatDirectory)
    - Constructor
    - Methods
        - upload
        - download
        - deploy
        - setDefault
- [6. Version History](#Version)

---

<p id="Introduction"></p>

## 1. Introduction

This document aims to standardize the interaction between applications and the EthStorage network to achieve reliable and efficient data management functionality.

This document includes two main classes: `EthStorage` and `FlatDirectory`. 
The `EthStorage` class provides asynchronous read and write operations for key-value pairs of a specified size. 
The `FlatDirectory` class is a higher-level data management tool that provides methods for uploading and downloading data of arbitrary size.


<p id="Terminology"></p>

## 2. Terminology

- **SDK**: Software Development Kit, a library that provides data upload and storage functionality.
- **Method**: Callable functions provided by the SDK.
- **Callback Function**: Provided by the user, passed as a parameter to methods, used to handle asynchronous operation results.


<p id="Class_Overview"></p>

## 3. Class Overview

### EthStorage Class

| Method Name  | Description                      |
|--------------|----------------------------------|
| constructor  | Create an instance of EthStorage |
| write        | Asynchronously write data        |
| read         | Asynchronously read data         |

### FlatDirectory Class

| Method Name | Description                                  |
|-------------|----------------------------------------------|
| constructor | Create an instance of FlatDirectory          |
| upload      | Asynchronously upload data of arbitrary size |
| download    | Asynchronously download data                 |
| deploy      | Deploy a FlatDirectory contract              |
| setDefault  | Set the default file for FlatDirectory.      |


<p id="EthStorage"></p>

## 4. EthStorage Class

### Constructor

**Description**: Create an instance of `EthStorage`.

**Parameters**
- `config` (object): Configuration object containing necessary settings.
   - `rpc` (string): RPC for any evm network.
   - `privateKey` (string): Wallet private key.
   - `address` (string): EthStorage contract address.

**Example**
```javascript
const config = {
   rpc: "your_rpc",
   privateKey: "your_private_key",
   address: "eth_storage_address"
};

const ethStorage = new EthStorage(config);
```

### Methods

#### write

**Description**: Asynchronously writes data to the EthStorage network.

**Parameters**
- `key` (string): The key for the data to be written.
- `data` (Buffer): The data to be written, its size cannot exceed the maximum value of the content that can be transferred by a blob.

**Example**
```javascript
const dataToWrite = Buffer.from("some data");
await ethStorage.write("dataKey", dataToWrite);
```

#### read

**Description**: Read data asynchronously from the EthStorage network through key.

**Parameters**
- `key` (string): The key for the data to be read.
- `ethStorageRpc` (string): RPC of EthStorage network, because the data is obtained from the EthStorage network.

**Returns**
- `data` (Buffer): The content.

**Example**
```javascript
const ethStorageRpc = "https://xxx.rpc";
const data = await ethStorage.read("example.txt", ethStorageRpc);
```


<p id="FlatDirectory"></p>

## 5. FlatDirectory Class

### Constructor

**Description**: Create an instance of `FlatDirectory`.

**Parameters**
- `config` (object): Configuration object containing necessary settings.
    - `rpc` (string): RPC for any evm network.
    - `privateKey` (string): Wallet private key.
    - `address` (string, optional): FlatDirectory contract address. If it does not exist, the `deploy` method can be called to create one.

**Example**
```javascript
const config = {
   rpc: "your_rpc",
   privateKey: "your_private_key",
   address: "flat_directory_address"
};

const flatDirectory = new FlatDirectory(config);
```

### Methods

#### upload

**Description**: Upload data of arbitrary size.

**Parameters**
- `key` (string): The key of the data.
- `data` (Buffer): The data to be uploaded.
- `callbacks` (object): An object containing callback functions:
  - `onProgress` (function): Callback function that receives `(progress)`, where `progress` is an object containing `count` and `totalCount`.
  - `onFail` (function): Callback function that receives `(error)`.
  - `onSuccess` (function): Callback function that receives `()`.

**Example**
```javascript
const key = "example1.txt";
const data = Buffer.from("large data to upload");

await ethStorage.upload(key, data, {
    onProgress: function(progress) {
        console.log(`Uploaded ${progress.count} of ${progress.totalCount} chunks`);
    },
    onFail: function(error) {
        console.error("Error uploading data:", error);
    },
    onSuccess: function() {
        console.log("Data uploaded success.");
    }
});
```

#### download

**Description**: Download data by key.

**Parameters**
- `key` (string): The key for the data to be read.
- `ethStorageRpc` (string): RPC of EthStorage network, because the data is obtained from the EthStorage network.

**Returns**
- `data` (Buffer): The content.

**Example**
```javascript
const ethStorageRpc = "https://xxx.rpc";

const data = await ethStorage.download("example.txt", ethStorageRpc);
```


#### deploy

**Description**: Deploy a FlatDirectory contract.

**Parameters**
- `ethStorageAddress` (string): EthStorage contract address, used to store data in EthStorage.

**Returns**
- `address` (string): FlatDirectory address.

**Example**
```javascript
const ethStorageAddress = "0x804C520d3c084C805E37A35E90057Ac32831F96f";
const data = await ethStorage.deploy(ethStorageAddress);
```


#### setDefault

**Description**: Set the default file for FlatDirectory.

**Parameters**
- `defaultFile` (string): The filename of the default file.

**Example**
```javascript
const defaultFile = "index.html";
await ethStorage.setDefault(defaultFile);
```

<p id="Version"></p>

## 6. Version History

- v1.0.0: Initial release with basic storage and data management functionalities.
