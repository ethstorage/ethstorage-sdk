
window.Buffer = window.Buffer || require("buffer").Buffer;

const getFileInfo = (file) => {
    return {
        isFile: true,
        name: file.name,
        size: file.size
    };
}

const getFileChunk = (file, fileSize, start, end) => {
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

module.exports = {
    getFileInfo,
    getFileChunk,
}
