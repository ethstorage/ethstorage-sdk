import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

const sharedPlugins = [
    commonjs(),
    resolve(),
    typescript({
        tsconfig: './tsconfig.json',
        declaration: true,
        declarationDir: 'dist/types',
        rootDir: 'src',
    }),
];

export default [
    {
        input: 'src/index.ts',
        output: [
            {
                file: 'dist/index.cjs',
                format: 'cjs',
                sourcemap: true
            },
            {
                file: 'dist/index.mjs',
                format: 'esm',
                sourcemap: true
            }
        ],
        plugins: sharedPlugins,
        external: ["ethers", "kzg-wasm", "workerpool"]
    },
    {
        input: 'src/node/file.ts',
        output: [
            {
                file: 'dist/file.cjs',
                format: 'cjs',
                sourcemap: true,
            },
            {
                file: 'dist/file.mjs',
                format: 'esm',
                sourcemap: true,
            },
        ],
        plugins: sharedPlugins,
        external: ["ethers"]
    },
    {
        input: 'src/worker/worker.ts',
        output: [
            {
                file: 'dist/worker.cjs',
                format: 'cjs',
                sourcemap: true,
            },
            {
                file: 'dist/worker.mjs',
                format: 'esm',
                sourcemap: true,
            },
        ],
        plugins: sharedPlugins,
        external: ["kzg-wasm", "workerpool"]
    },
];
