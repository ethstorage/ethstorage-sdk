// src/file/file.js
var fs = require("fs");
var getFileInfo = (filePath) => {
  const fileStat = fs.statSync(filePath);
  if (fileStat.isFile()) {
    const name = filePath.substring(filePath.lastIndexOf("/") + 1);
    return {
      isFile: true,
      name,
      size: fileStat.size
    };
  }
  return {
    isFile: false
  };
};
var getFileChunk = (filePath, fileSize, start, end) => {
  end = end > fileSize ? fileSize : end;
  const length = end - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, length, start);
  fs.closeSync(fd);
  return buf;
};
module.exports = {
  getFileInfo,
  getFileChunk
};
//# sourceMappingURL=file.js.map