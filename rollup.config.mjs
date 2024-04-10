import commonjs from '@rollup/plugin-commonjs';
import {terser} from 'rollup-plugin-terser';
import resolve from '@rollup/plugin-node-resolve';

export default [
    {
        input: "./src/index-node.js",
        output: {
            file: 'dist/index.cjs.js', format: 'cjs', sourcemap: true
        },
    },
    {
        input: "./src/index-browser.js",
        output: {
            file: "./dist/index.esm.js", format: "esm", sourcemap: true
        },
        plugins: [
            commonjs(),
            resolve()
        ],
        external: ["kzg-wasm", "ethers"],
    }
];

