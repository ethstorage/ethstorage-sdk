
const { EthStorage, FlatDirectory, DecodeType } = require("./dist/index.cjs");
const crypto = require('crypto');
const ethers = require('ethers');
const dotenv = require("dotenv");

dotenv.config()

const blobsPerTx = 1;
const batchSize = 10;

function fill(pre, length) {
    let str = crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
    return Buffer.from(pre + str, 'utf8');
}

async function upload(es, batchIndex) {
    const keys = Array.from({ length: blobsPerTx }, (_, i) => `key_${batchIndex}_${i}`);
    // const keys = Array.from({ length: batchSize }, (_, i) => `key_same`);
    const data = Array.from({ length: blobsPerTx }, (_, i) => Buffer.from(`data_${batchIndex}_${i}_`));

    data.forEach((d, i) => {
        data[i] = Buffer.concat([d, fill(d, 31 * 4096 - d.length)]);
    })

    // const cost = await es.estimateCost("batch", data[0]);
    // console.log("cost estimated:", cost)
    console.log("uploading", keys);
    return await es.writeBlobs(keys, data);
}

async function main0() {

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
            // rpc: 'https://rpc.beta.testnet.l2.quarkchain.io:8545',
            rpc: "http://65.108.230.142:8545",
            // ethStorageRpc: 'https://rpc.beta.testnet.l2.ethstorage.io:9596',
            privateKey: pks[i],
            address: "0x1AE7F69546b01e16CAad15EdF903DF1904DABB16"
        })

        let wallet = new ethers.Wallet(pks[i]);
        esWithAddrs.push({ es: es, addr: wallet.address })
    }

    console.log(new Date(), 'start uploading');

    let shouldContinue = true;

    setTimeout(() => {
        console.log('Timeout: Breaking the loop');
        shouldContinue = false;
    }, 5 * 60 * 1000);

    while (shouldContinue) {
        await Promise.all(
            esWithAddrs.map(
                async ({ es, addr }, index) => {
                    const currentBatchIndex = batchIndex + index;
                    await new Promise(resolve => setTimeout(resolve, index * 1000));
                    // console.log(new Date(), 'uploading batch', currentBatchIndex, 'by', addr);
                    const s = await upload(es, currentBatchIndex);
                    console.log(new Date(), 'uploading batch', currentBatchIndex, 'by', addr, s.success ? s.hash : 'failed');
                })
        );
        batchIndex += esWithAddrs.length;
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    console.log(new Date(), 'done uploading.');
    esWithAddrs.forEach(({ es, addr }) => {
        es.close();
    }
    );
}


async function main() {

    const value = process.env.pk;
    const pks = value.split(',');
    const es = await EthStorage.create({
        // rpc: 'https://rpc.beta.testnet.l2.quarkchain.io:8545',
        // rpc: "http://65.108.236.27:8554",
        // rpc: "https://sepolia.drpc.org",
        // rpc: "https://ethereum-sepolia.gateway.tatum.io",
        rpc: "http://65.108.230.142:8545",
        // ethStorageRpc: 'https://rpc.beta.testnet.l2.ethstorage.io:9596',
        ethStorageRpc: "https://rpc.testnet.ethstorage.io:9546",
        privateKey: pks[0],
        // address: "0x1AE7F69546b01e16CAad15EdF903DF1904DABB16"
    })
    const key = `unique_key_${Date.now()}`;
    const data = fill(`data_of_${key}`, 31 * 4096);
    const s = await es.write(key, data);
    const writeReturnedAt = Date.now();
    console.log(new Date(), 'uploaded', key, s.success ? s.hash : 'failed');
    if (!s.success) {
        console.error('Upload failed, exiting');
        await es.close();
        return;
    }
    async function readWithRetryUntilAvailable() {
        let lastError;
        for (let attempt = 1; attempt <= 20; attempt++) {
            try {
                const data = await es.read(key);
                if (data && data.length > 0) return data;
                lastError = new Error('Empty data returned');
            } catch (e) {
                // Keep retrying on "no data" and transient RPC errors.
                const errText = ((e && (e.stack || e.message)) ? (e.stack || e.message) : String(e)) || '';
                console.error(new Date(), 'read', errText.slice(0, 100));
                lastError = e;
            }

            if (attempt < 20) {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        throw new Error(`Read failed after 20 attempts: ${lastError?.message || lastError}`);
    }

    const buff = await readWithRetryUntilAvailable();
    const elapsedMs = Date.now() - writeReturnedAt;
    console.log(new Date(), `write->read success elapsed: ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(2)}s)`);
    const decodedPrefix = Buffer.from(buff.slice(0, 32)).toString('utf8');
    console.log(new Date(), 'downloaded key:', key, "data:", decodedPrefix);
    await es.close();
}


main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
