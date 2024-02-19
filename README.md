# EthStorage SDK
ETHStorage sdk, used for uploading and downloading blobs. The sdk is implemented based on c-kzg, so it does not support the browser environment.

## Installation

With [npm](https://npmjs.org) do

```bash
$ npm install ethstorage-sdk
```



## blobs.js
#### EncodeBlobs
Convert files to blobs
```js
const content = fs.readFileSync(filePath);
const blobs = EncodeBlobs(content);
```

#### DecodeBlob
Restore blob to file contents
```js
const fileData = DecodeBlobs(blobs);
```

#### EncodeOPBlobs
Convert files to blobs
```js
const content = fs.readFileSync(filePath);
const blobs = EncodeOpBlobs(content);
```


## uploader.js
Send blob type transaction
```js
const uploader = new BlobUploader(rpc, privateKey);
const hash = await uploader.sendTx(tx, blobs);
```



## download.js
Data is obtained using the eip-5018 standard
```js
const data = await DownloadFile(ethStorageRPC, contractAddress, fileName);
```



## ethstorage.js
Use this tool to create an ETHStorage storage contract and upload files to the contract.
```js
// deploy
const ethStorage = new EthStorage(rpc, privateKey);
await ethStorage.deployDirectory(ethStorageAddress);
// or set contract
ethStorage = new EthStorage(rpc, privateKey, contractAddress);

// upload
await ethStorage.upload(filePath);

//  download
const data = await ethStorage.download(fileName, ethStorageRPC);
```


### Example
Upload files to the ETH network, See [here](https://github.com/ethstorage/ethstorage-sdk/blob/main/test.js) for details.
