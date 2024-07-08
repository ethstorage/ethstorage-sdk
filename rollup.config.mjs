import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';

export default [
    {
        input: {
            'index.cjs': './src/index.js',
            'file.cjs': './src/node/file.js',
        },
        output: {
            dir: 'dist', format: 'cjs', sourcemap: true
        },
        plugins: [commonjs(), resolve()],
        external: ["ethers", "kzg-wasm"]
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
        external: ["ethers", "kzg-wasm"]
    }
];

