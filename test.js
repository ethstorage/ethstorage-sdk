const {EthStorage, FlatDirectory} = require("./dist/index.cjs.js");
const {NodeFile} = require("./dist/file.cjs.js");
const fs = require('fs');
const os = require('os');

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
        rpc: 'https://rpc.testnet.l2.quarkchain.io:8545',
        ethStorageRpc: 'https://rpc.testnet.l2.ethstorage.io:9540',
        privateKey
    })

    const content = fs.readFileSync(filePath);
    // estimate cost
    const cost = await es.estimateCost(name, content.length > 126976 ? content.subarray(0, 126976) : content);
    console.log("cost:", cost)

    // write
    let status = await es.write(name, content.length > 126976 ? content.subarray(0, 126976) : content);
    console.log("status:", status)
    // read
    let buff = await es.read(name);
    const p = saveFile(buff);
    console.log(p)

    // put blobs
    const keys = ["key1", "key2"];
    const blobData = [Buffer.from("some data1"), Buffer.from("some data2")];
    status = await es.writeBlobs(keys, blobData);
    console.log("status:", status)
    // read
    buff = await es.read('key2');
    console.log(Buffer.from(buff).toString());
}
// EthStorageTest();

async function FlatDirectoryTest() {
    const fd = await FlatDirectory.create({
        rpc: 'https://rpc.testnet.l2.quarkchain.io:8545',
        ethStorageRpc: 'https://rpc.testnet.l2.ethstorage.io:9540',
        privateKey,
        // address: "0x91F57C2d88C55B7a2Dd6DC76ddae3891b8003CE8"
    })

    await fd.deploy();

    const uploadCallback = {
        onProgress: (progress, count, isChange) => {
            console.log(`progress:${progress}, count:${count}, isChange:${isChange}`);
        },
        onFail: (err) => {
            console.log(err);
        },
        onFinish: (totalUploadChunks, totalUploadSize, totalStorageCost) => {
            console.log(`totalUploadChunks:${totalUploadChunks}, totalUploadSize:${totalUploadSize}, totalStorageCost:${totalStorageCost}`);
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
    await fd.download("blobFile", {
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
}
FlatDirectoryTest();
