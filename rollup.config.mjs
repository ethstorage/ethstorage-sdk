import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

export default {
    input: 'src/index.js',
    output: [
        { file: 'dist/index.esm.js', format: 'esm' },
        { file: 'dist/index.cjs.js', format: 'cjs' }
    ],
    plugins: [
        nodeResolve(),
        commonjs(),
        json(),
    ]
};
