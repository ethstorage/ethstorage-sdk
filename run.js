
const { EthStorage } = require("./dist/index.cjs.js");
const crypto = require('crypto');
const dotenv = require("dotenv")
dotenv.config()
const privateKey = process.env.pk;


function fill(length) {
    let str = crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
    return Buffer.from(str, 'utf8');
}

async function upload(es, batchIndex) {
    const keys = Array.from({ length: 6 }, (_, i) => `key_${batchIndex}_${i}`);
    const data = Array.from({ length: 6 }, (_, i) => Buffer.from(`data_${batchIndex}_${i}_`));

    data.forEach((d, i) => {
        data[i] = Buffer.concat([d, fill(31 * 4096 - d.length)]);
        // console.log(keys[i], "=>", data[i].toString().slice(0, 18) + "...");
    })

    console.log("batch", batchIndex, "=>", await es.writeBlobs(keys, data), new Date())
}

async function main() {

    const es = await EthStorage.create({
        rpc: 'http://65.109.20.29:8545',
        ethStorageRpc: 'http://65.109.115.36:9540',
        privateKey
    })

    console.log('start uploading at', new Date());

    let batchIndex = 30
    setInterval(() => {
        upload(es, batchIndex);
        console.log('uploading batch', batchIndex, 'at', new Date());
        batchIndex++;
    }, 2000);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
