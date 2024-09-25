
const { EthStorage } = require("./dist/index.cjs.js");
const crypto = require('crypto');
const ethers = require('ethers');
const dotenv = require("dotenv");

dotenv.config()

const blobsPerTx = 1;
const batchSize = 4870;

function fill(length) {
    let str = crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
    return Buffer.from(str, 'utf8');
}

async function upload(es, batchIndex) {
    // const keys = Array.from({ length: blobsPerTx }, (_, i) => `key_${batchIndex}_${i}`);
    const keys = Array.from({ length: batchSize }, (_, i) => `key_same`);
    const data = Array.from({ length: blobsPerTx }, (_, i) => Buffer.from(`data_${batchIndex}_${i}_`));

    // data.forEach((d, i) => {
    //     data[i] = Buffer.concat([d, fill(31 * 4096 - d.length)]);
    // })
    return await es.writeBlobs(keys, data);
}

async function main() {

    let batchIndex = 0
    const args = process.argv.slice(2);
    if (args.length > 0) {
        batchIndex = parseInt(args[0]);
    }
    console.log("batchIndex", batchIndex)


    const value = process.env.pk;
    const pks = value.split(',');
    const esWithAddrs = []

    for (let i = 0; i < pks.length; i++) {
        const es = await EthStorage.create({
            rpc: 'http://65.109.20.29:8545',
            // rpc: 'http://88.99.30.186:8545',
            ethStorageRpc: 'http://65.109.115.36:9540',
            privateKey: pks[i]
        })

        let wallet = new ethers.Wallet(pks[i]);
        esWithAddrs.push({ es: es, addr: wallet.address })
    }

    console.log(new Date(), 'start uploading');

    let shouldContinue = true;

    setTimeout(() => {
        console.log('Timeout: Breaking the loop');
        shouldContinue = false;
    }, 1 * 1000);

    while (shouldContinue) {
        await Promise.all(
            esWithAddrs.map(
                async ({ es, addr }, index) => {
                    const currentBatchIndex = batchIndex + index;
                    await new Promise(resolve => setTimeout(resolve, index * 1000));
                    console.log(new Date(), 'uploading batch', currentBatchIndex, 'by', addr);
                    const s = await upload(es, currentBatchIndex);
                    console.log(new Date(), 'uploading batch', currentBatchIndex, 'by', addr, s ? 'successfully' : 'failed');
                })
        );
        batchIndex += esWithAddrs.length;
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    console.log(new Date(), 'done uploading.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
