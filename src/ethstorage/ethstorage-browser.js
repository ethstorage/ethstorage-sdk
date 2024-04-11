import {BaseEthStorage} from "./ethstorage";

export class EthStorage extends BaseEthStorage{
    getFileInfo(file) {
        return {
            isFile: true,
            name: file.name,
            size: file.size
        };
    }

    async getFileChunk(file, fileSize, start, end) {
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
