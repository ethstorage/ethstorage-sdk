# Update EIP4844 Blobs
eip-4844 blobs upload sdk.

## Installation

With [npm](https://npmjs.org) do

```bash
$ npm install ethstorage-sdk
```


### upload blobs
```js
const contractAddress = '0x038dB...E8F38F82'
const contractABI = [
    'function writeChunk(bytes memory name) public payable'
]
const provider = new ethers.providers.JsonRpcProvider('https://rpc.dencun-devnet-12.ethpandaops.io/');
const contract = new Contract(contractAddress, contractABI, provider);
// create tx
const tx = await contract.populateTransaction.writeChunk(hexName, {
    value: 100000000
});

...

// read file and create blobs
const content = fs.readFileSync(filePath);
const blobs = EncodeBlobs(content);

...

// send blob
const send4844Tx = new Send4844Tx('https://rpc.dencun-devnet-12.ethpandaops.io/', "private key");
const hash = await send4844Tx.sendTx(tx, blobs);
const txReceipt = await blobUploader.getTxReceipt(hash);
console.log(txReceipt);
```
