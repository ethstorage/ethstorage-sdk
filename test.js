const { FlatDirectory } = require("./dist/node/index.cjs");
const { NodeFile } = require("./dist/node/file.cjs");
const dotenv = require("dotenv");

dotenv.config();
const privateKey = process.env.pk;

const filePath = '/Users/dl/test/testUpload/esmark.jpeg';

async function FlatDirectoryTest() {
    const fd = await FlatDirectory.create({
        rpc: 'https://rpc.beta.testnet.l2.quarkchain.io:8545',
        ethStorageRpc: 'https://rpc.beta.testnet.l2.ethstorage.io:9596',
        privateKey,
    })
    const address = await fd.deploy();
    console.log("FlatDirectory deployed at:", address);

    const uploadCallback = {
        onProgress: (progress, count, isChange) => {
        },
        onFail: (err) => {
            console.log(err);
        },
        onFinish: (totalUploadChunks, totalUploadSize, totalCost) => {
            console.log(new Date(), `totalUploadChunks:${totalUploadChunks}, totalUploadSize:${totalUploadSize}, totalCost:${totalCost}`);
        }
    };

    const hashes = await fd.fetchHashes(["file.jpg", "blobFile.jpg"]);

    const file = new NodeFile(filePath);
    for (let i = 0; i < 20; i++) {
        const request = {
            type: 2,
            key: `blobFile.jpg_${i}`,
            content: file,
            gasIncPct: 5,
            chunkHashes: hashes[1],
            callback: uploadCallback
        };
        console.log(new Date(), `[${i + 1}/20] uploading`, request.key);
        await fd.upload(request);
        await measureSyncLatency(fd, request.key);
    }
}

async function measureSyncLatency(fd, key) {
    const start = Date.now();
    while (true) {
        let success = false;

        await fd.download(key, {
            onProgress: (progress, count, data) => {
            },
            onFail: (err) => {
            },
            onFinish: () => {
                success = true;
                console.log(new Date(), `${(Date.now() - start) / 1000} download finish`)
            }
        });

        if (success) {
            return;
        }
    };
}

async function main() {
    await FlatDirectoryTest();
}
main()

