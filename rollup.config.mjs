import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';

export default [
    {
        input: 'src/index.js',
        output: [
            {
                file: 'dist/index.cjs.js',
                format: 'cjs',
            },
            {
                file: 'dist/index.esm.js',
                format: 'esm',
            }
        ],
        plugins: [commonjs(), resolve()],
        external: ["ethers", "kzg-wasm"]
    },
    {
        input: 'src/node/file.js',
        output: {
            file: 'dist/file.cjs.js',
            format: 'cjs',
        },
        plugins: [commonjs(), resolve()],
        external: ["ethers"]
    }
];

