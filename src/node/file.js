import fs from 'fs';
import {assertArgument} from "ethers";

export class NodeFile {
    constructor(filePath, start = 0, end = null, type = '') {
        this.filePath = filePath;
        this.type = type;

        assertArgument(fs.existsSync(filePath), "invalid file path", "file", filePath);
        const stat = fs.statSync(filePath);
        this.start = Math.min(start, stat.size - 1);
        this.end = end == null ? stat.size : Math.min(end, stat.size);
        this.size = this.end - this.start;
        assertArgument(this.size > 0, "invalid file size", "file", this.size);
    }

    slice(start, end) {
        const newStart = this.start + start;
        const newEnd = newStart + (end - start);
        assertArgument(newStart < newEnd && newEnd <= this.end, "invalid slice range", "file", {start, end});
        return new NodeFile(this.filePath, newStart, newEnd, this.type);
    }

    async arrayBuffer() {
        const start = this.start;
        const end = this.end;
        const length = end - start;
        const buf = Buffer.alloc(length);
        const fd = fs.openSync(this.filePath, 'r');
        fs.readSync(fd, buf, 0, length, start);
        fs.closeSync(fd);
        return buf;
    }

    async text() {
        const buffer = await this.arrayBuffer();
        return new TextDecoder().decode(buffer);
    }

    stream() {
        const start = this.start;
        const end = this.end;
        return fs.createReadStream(this.filePath, {start, end});
    }
}
