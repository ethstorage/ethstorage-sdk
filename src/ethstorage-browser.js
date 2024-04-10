import {EthStorage} from "./ethstorage";


class EthStorageBrowser extends EthStorage{
    getFileInfo(file) {
        return {
            isFile: true,
            name: file.name,
            size: file.size
        };
    }

    getFileChunk(file, fileSize, start, end) {
        end = end > fileSize ? fileSize : end;
        const slice = file.slice(start, end);
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (res) => {
                resolve(Buffer.from(res.target.result));
            };
            reader.readAsArrayBuffer(slice);
        });
    }
}

module.exports = {
    EthStorageBrowser
}
