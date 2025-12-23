const {EthStorage, FlatDirectory, DecodeType} = require("./dist/index.cjs");
const {NodeFile} = require("./dist/file.cjs");
const fs = require('fs');
const os = require('os');
const {ethers} = require('ethers');

const dotenv = require("dotenv")
dotenv.config()
const privateKey = process.env.pk;

const filePath = '/Users/lmp/Downloads/dist/img122.jpeg';
const filePath2 = '/Users/lmp/Downloads/dist/img123.jpeg';
const name = filePath.substring(filePath.lastIndexOf("/") + 1);

const saveFile = (data) => {
    const exp = new Date();
    const path = `${os.tmpdir()}/${exp.getTime()}`;
    fs.writeFileSync(path, data);
    return path;
}

async function EthStorageTest() {
    const es = await EthStorage.create({
        rpc: 'http://65.108.230.142:8545/',
        ethStorageRpc: 'https://rpc.testnet.ethstorage.io:9546',
        privateKey
    })

    const content = fs.readFileSync(filePath);
    // estimate cost
    const cost = await es.estimateCost(name, content.length > 126976 ? content.subarray(0, 126976) : content);
    console.log("cost:", cost)

    // write
    let result = await es.write(name, content.length > 126976 ? content.subarray(0, 126976) : content);
    console.log("status:", result.success, result.hash);
    // read
    setTimeout(() => {}, 2000);
    let buff = await es.read(name);
    const p = saveFile(buff);
    console.log(p)

    // put blobs
    const keys = ["key1", "key2"];
    const blobData = [Buffer.from("some data1"), Buffer.from("some data2")];
    result = await es.writeBlobs(keys, blobData);
    console.log("status:", result.success, result.hash);
    // read
    setTimeout(() => {}, 2000);
    buff = await es.read('key2');
    console.log(Buffer.from(buff).toString());
    await es.close();

    // only read
    const readEs = await EthStorage.create({
        rpc: 'http://65.108.230.142:8545/',
        ethStorageRpc: 'https://rpc.testnet.ethstorage.io:9546',
    })
    // read
    const wallet = new ethers.Wallet(privateKey);
    buff = await readEs.read('key2', DecodeType.OptimismCompact, wallet.address);
    console.log(Buffer.from(buff).toString());
    await readEs.close();
}

async function FlatDirectoryTest() {
    const fd = await FlatDirectory.create({
        rpc: 'http://65.108.230.142:8545/',
        ethStorageRpc: 'https://rpc.testnet.ethstorage.io:9546',
        privateKey,
        // address: "0x808f50c22D18D137AEf6E464E3f83af5FFc78b7A"
    })

    const address = await fd.deploy();

    const uploadCallback = {
        onProgress: (progress, count, isChange) => {
            console.log(`progress:${progress}, count:${count}, isChange:${isChange}`);
        },
        onFail: (err) => {
            console.log(err);
        },
        onFinish: (totalUploadChunks, totalUploadSize, totalCost) => {
            console.log(`totalUploadChunks:${totalUploadChunks}, totalUploadSize:${totalUploadSize}, totalCost:${totalCost}`);
        }
    };

    const hashes = await fd.fetchHashes(["file.jpg", "blobFile.jpg"]);
    console.log(hashes);

    // calldata
    // data
    let request = {
        type: 1,
        key: "data",
        content: Buffer.from("12345678"),
        gasIncPct: 10,
        callback: uploadCallback
    }
    let cost = await fd.estimateCost(request);
    console.log(cost);
    await fd.upload(request);
    cost = await fd.estimateCost(request);
    console.log(cost);
    console.log("");

    // file
    let file = new NodeFile(filePath);
    request = {
        type: 1,
        key: "file.jpg",
        content: file,
        gasIncPct: 10,
        callback: uploadCallback
    }
    cost = await fd.estimateCost(request);
    console.log(cost);
    await fd.upload(request);
    cost = await fd.estimateCost(request);
    console.log(cost);
    console.log("");


    // blob
    // data
    request = {
        type: 2,
        key: "blobData",
        content: Buffer.from("12345678"),
        gasIncPct: 5,
        callback: uploadCallback
    }
    cost = await fd.estimateCost(request);
    console.log(cost);
    await fd.upload(request);
    cost = await fd.estimateCost(request);
    console.log(cost);
    console.log("");

    // file
    file = new NodeFile(filePath2);
    request = {
        type: 2,
        key: "blobFile.jpg",
        content: file,
        gasIncPct: 5,
        chunkHashes: hashes[1],
        callback: uploadCallback
    }
    cost = await fd.estimateCost(request);
    console.log(cost);
    await fd.upload(request);
    cost = await fd.estimateCost(request);
    console.log(cost);
    console.log("");

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    await sleep(60000);

    // download
    await fd.download("data", {
        onProgress: (progress, count, data) => {
            console.log(progress, count, Buffer.from(data).toString());
        },
        onFail: (err) => {
            console.log(err)
        },
        onFinish: () => {
            console.log('download finish');
        }
    });
    await fd.download("blobFile.jpg", {
        onProgress: (progress, count, data) => {
            console.log(progress, count, data.length);
        },
        onFail: (err) => {
            console.log(err)
        },
        onFinish: () => {
            console.log('download finish');
        }
    });

    const hashes2 = await fd.fetchHashes(["file.jpg", "blobFile.jpg"]);
    console.log("get hashes", hashes2);

    await fd.close();

    console.log("only download")
    const downloadFd = await FlatDirectory.create({
        ethStorageRpc: 'https://rpc.testnet.ethstorage.io:9546',
        address: address
    })
    await downloadFd.download("blobFile.jpg", {
        onProgress: (progress, count, data) => {
            console.log(progress, count, data.length);
        },
        onFail: (err) => {
            console.log(err)
        },
        onFinish: () => {
            console.log('download finish');
        }
    });

    await downloadFd.close();
}

async function main() {
    await EthStorageTest();
    await FlatDirectoryTest();
}
main()

