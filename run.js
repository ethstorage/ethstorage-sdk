
const { EthStorage } = require("./dist/index.cjs.js");
const crypto = require('crypto');
const ethers = require('ethers');
const { formatEther } = require("ethers/utils");
const dotenv = require("dotenv");

dotenv.config()


function fill(length) {
    let str = crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
    return Buffer.from(str, 'utf8');
}

async function upload(es, batchIndex) {
    const keys = Array.from({ length: 6 }, (_, i) => `key_${batchIndex}_${i}`);
    const data = Array.from({ length: 6 }, (_, i) => Buffer.from(`data_${batchIndex}_${i}_`));

    data.forEach((d, i) => {
        data[i] = Buffer.concat([d, fill(31 * 4096 - d.length)]);
    })
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
    }, 24 * 3600 * 1000);

    while (shouldContinue) {
        for (let i = 0; i < esWithAddrs.length; i++) {
            let esa = esWithAddrs[i]
            const s = await upload(esa.es, batchIndex)
            console.log(new Date(), 'uploading batch', batchIndex, s ? 'successfully' : 'failed', 'by', esa.addr);
            batchIndex++;
        }
    }
    console.log(new Date(), 'done uploading.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
