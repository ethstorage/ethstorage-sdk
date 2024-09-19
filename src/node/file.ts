import fs from 'fs';
import { assertArgument } from 'ethers';

export class NodeFile {
    isNodeJs: boolean;

    filePath: string;
    type: string;
    size: number;
    start: number;
    end: number;

    constructor(filePath: string, start: number = 0, end: number = 0, type: string = '') {
        this.isNodeJs = true;
        this.filePath = filePath;
        this.type = type;

        assertArgument(fs.existsSync(filePath), "invalid file path", "file", filePath);
        const stat = fs.statSync(filePath);
        this.start = Math.min(start, stat.size - 1);
        this.end = end == 0 ? stat.size : Math.min(end, stat.size);
        this.size = this.end - this.start;
        assertArgument(this.size > 0, "invalid file size", "file", this.size);
    }

    slice(start: number, end: number): NodeFile {
        const newStart = this.start + start;
        const newEnd = newStart + (end - start);
        assertArgument(newStart < newEnd && newEnd <= this.end, "invalid slice range", "file", { start, end });
        return new NodeFile(this.filePath, newStart, newEnd, this.type);
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const start = this.start;
        const end = this.end;
        const length = end - start;

        const arrayBuffer = new ArrayBuffer(length);
        const uint8Array = new Uint8Array(arrayBuffer);
        const fd = fs.openSync(this.filePath, 'r');
        fs.readSync(fd, uint8Array, 0, length, start);
        fs.closeSync(fd);
        return arrayBuffer;
    }

    async text(): Promise<string> {
        const buffer = await this.arrayBuffer();
        return new TextDecoder().decode(buffer);
    }

    stream(): fs.ReadStream {
        const start = this.start;
        const end = this.end;
        return fs.createReadStream(this.filePath, { start, end });
    }
}
