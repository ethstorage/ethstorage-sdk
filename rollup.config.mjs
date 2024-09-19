import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

export default [
    {
        input: 'src/index.ts',
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
        plugins: [commonjs(), resolve(), typescript({
            tsconfig: './tsconfig.json',
            declaration: true,
            declarationDir: 'dist/types',
            rootDir: 'src',
        })],
        external: ["ethers", "kzg-wasm", "workerpool"]
    },
    {
        input: 'src/node/file.ts',
        output: {
            file: 'dist/file.cjs.js',
            format: 'cjs',
            sourcemap: true,
        },
        plugins: [commonjs(), resolve(), typescript()],
        external: ["ethers"]
    },
    {
        input: 'src/worker/worker.ts',
        output: {
            file: 'dist/worker.cjs.js',
            format: 'cjs',
            sourcemap: true,
        },
        plugins: [commonjs(), resolve(), typescript()],
        external: ["kzg-wasm", "workerpool"]
    },
];
