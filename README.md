# ethstorage-sdk
used for uploading and downloading blobs. The sdk is implemented based on [kzg-wasm](https://github.com/ethereumjs/kzg-wasm/), support the browser environment.

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

or

const reader = new FileReader();
reader.onload = (res) => {
    const content = Buffer.from(res.target.result);
    const blobs = EncodeBlobs(content);
};
reader.readAsArrayBuffer(file);
```

#### DecodeBlob
Restore blob to file contents
```js
const fileData = DecodeBlobs(blobs);
```



### uploader.js
Send blob type transaction
```js
const uploader = new BlobUploader(rpc, privateKey);
const txResponse = await uploader.sendTx(tx, blobs);
```



### download.js
Data is obtained using the eip-5018 standard
```js
// Since the data is downloaded from ethstorage, the provided RPC should be an ethstorage RPC.
const data = await DownloadFile(ethstorageRpc, contractAddress, fileName);
```



### ethstorage.js
Use this tool to create an ETHStorage contract and upload files to the contract.
```js
const ethStorage = new EthStorage(rpc, privateKey);

// deploy
await ethStorage.deployBlobDirectory();
// or set contract
ethStorage = new EthStorage(rpc, privateKey, contractAddress);

// upload
await ethStorage.upload(fileOrPath);
```


### Example
Upload files to the ETH network, See [here](https://github.com/ethstorage/ethstorage-sdk/blob/main/test.js) for details.
