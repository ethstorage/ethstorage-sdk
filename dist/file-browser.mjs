var __getOwnPropNames = Object.getOwnPropertyNames;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/file/file-browser.js
var require_file_browser = __commonJS({
  "src/file/file-browser.js"(exports, module) {
    window.Buffer = window.Buffer || __require("buffer").Buffer;
    var getFileInfo = (file) => {
      return {
        isFile: true,
        name: file.name,
        size: file.size
      };
    };
    var getFileChunk = (file, fileSize, start, end) => {
      end = end > fileSize ? fileSize : end;
      const slice = file.slice(start, end);
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (res) => {
          resolve(Buffer.from(res.target.result));
        };
        reader.readAsArrayBuffer(slice);
      });
    };
    module.exports = {
      getFileInfo,
      getFileChunk
    };
  }
});
export default require_file_browser();
//# sourceMappingURL=file-browser.mjs.map