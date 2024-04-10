import commonjs from '@rollup/plugin-commonjs';
import {terser} from 'rollup-plugin-terser';
import resolve from '@rollup/plugin-node-resolve';

export default [
    {
        input: "./src/index.js",
        output: {
            file: 'dist/index.cjs.js', format: 'cjs', sourcemap: true
        },
        plugins: [commonjs(), resolve()],
        external: ["kzg-wasm", "ethers"],
    },
    {
        input: "./src/index.js",
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

