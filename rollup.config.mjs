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
        external: ["kzg-wasm"],
    },
    {
        input: "./src/index.js",
        output: {
            file: "./dist/index.esm.js", format: "esm", sourcemap: true
        },
        plugins: [
            commonjs(),
            resolve({
                dedupe: ['fs', 'path', 'module'],
                module: false, fs: false, path: false
            })
        ],
        external: ["kzg-wasm"],
    }
];

