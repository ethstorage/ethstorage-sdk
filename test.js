const {EthStorage, FlatDirectory} = require("./dist/index.cjs.js");
const fs = require('fs');
const os = require('os');

const dotenv = require("dotenv")
dotenv.config()
const privateKey = process.env.pk;

const filePath = '/Users/lmp/Downloads/dist/img123.jpeg';
const name = filePath.substring(filePath.lastIndexOf("/") + 1);

const saveFile = (data) => {
    const exp = new Date();
    const path = `${os.tmpdir()}/${exp.getTime()}`;
    fs.writeFileSync(path, data);
    return path;
}

async function EthStorageTest() {
    const es = await EthStorage.create({
        rpc: 'http://142.132.154.16:8545',
        ethStorageRpc: 'http://65.108.230.142:9545',
        privateKey
    })

    const content = fs.readFileSync(filePath);
    // estimate cost
    const cost = await es.estimateCost(name, content.length > 126976 ? content.subarray(0, 126976) : content);
    console.log(cost)

    // write
    let status = await es.write(name, content.length > 126976 ? content.subarray(0, 126976) : content);
    console.log(status);
    // read
    const buff = await es.read(name);
    const p = saveFile(buff);
    console.log(p)

    // put blobs
    // const es = await EthStorage.create({
    //     rpc: 'http://88.99.30.186:8545',
    //     privateKey
    // })
    // const status = await es.putBlobs(3, content);
    // console.log(status);
}
// EthStorageTest();

async function FlatDirectoryTest() {
    const fd = await FlatDirectory.create({
        rpc: 'http://142.132.154.16:8545',
        ethStorageRpc: 'http://65.108.230.142:9545',
        privateKey,
        address: "0x8b389E427CAC680ec3b4bDD3E370C5Ae9239e44f"
    })

    // await fd.deploy();

    const cost = await fd.estimateCost("key", Buffer.from("123456"));
    console.log(cost);

    await fd.upload("key", Buffer.from("123456"), {
        onProgress: (progress, count) => {
            console.log(progress, count);
        },
        onFail: (err) => {
            console.log(err);
        },
        onSuccess: (info) => {
            console.log(info);
        }
    });

    const value = await fd.download("key");
    console.log(value.toString());

    fd.downloadSync("key", {
        onProgress: (progress, count, data) => {
            console.log(progress, count, data.toString());
        },
        onFail: (err) => {
            console.log(err)
        },
        onSuccess: (data) => {
            console.log(data.toString());
        }
    })
}
FlatDirectoryTest();
