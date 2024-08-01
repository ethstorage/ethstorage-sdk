
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
    return await es.writeBlobs(keys, data);
}

async function main() {

    const es = await EthStorage.create({
        rpc: 'http://65.109.20.29:8545',
        ethStorageRpc: 'http://65.109.115.36:9540',
        privateKey
    })

    console.log(new Date(), 'start uploading');

    let shouldContinue = true;

    setTimeout(() => {
        console.log('Timeout: Breaking the loop');
        shouldContinue = false;
    }, 20000);

    let batchIndex = 36

    while (shouldContinue) {
        console.log(new Date(), 'uploading batch', batchIndex);
        const s = await upload(es, batchIndex)
        console.log(new Date(), 'uploading batch', batchIndex, s ? 'successfully' : 'failed');
        batchIndex++;
    }
    console.log(new Date(), 'done uploading.');    
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
