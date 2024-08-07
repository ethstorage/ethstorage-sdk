import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';

export default [
    {
        input: 'src/index.js',
        output: [
            {
                file: 'dist/index.cjs.js',
                format: 'cjs',
                sourcemap: true
            },
            {
                file: 'dist/index.esm.js',
                format: 'esm',
                sourcemap: true
            }
        ],
        plugins: [commonjs(), resolve()],
        external: ["ethers", "kzg-wasm", "workerpool"]
    },
    {
        input: 'src/node/file.js',
        output: {
            file: 'dist/file.cjs.js',
            format: 'cjs',
            sourcemap: true
        },
        plugins: [commonjs(), resolve()],
        external: ["ethers"]
    },
    {
        input: 'src/worker/worker.js',
        output: {
            file: 'dist/worker.js',
            format: 'umd',
            globals: {
                "workerpool": 'workerpool',
                "ethers": 'ethers',
                "kzg-wasm": "kzgWasm"
            },
        },
        plugins: [commonjs(), resolve()],
        external: ["ethers", "kzg-wasm", "workerpool"]
    },
];

