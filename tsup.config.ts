import { defineConfig } from 'tsup';

export default defineConfig([
    // browser
    {
        entry: ['src/index.ts'],
        format: ['esm'],
        platform: 'browser',
        dts: true,
        clean: true,
        external: ['ethers'],
        outDir: 'dist/browser',
        esbuildOptions(options) {
            options.define = {
                'process.env.NODE_ENV': '"production"',
                global: 'window',
            };
        },
        outExtension({ format }) {
            return { js: '.mjs' };
        },
    },

    // Node.js
    {
        entry: ['src/index.ts'],
        format: ['esm', 'cjs'],
        platform: 'node',
        dts: true,
        sourcemap: false,
        clean: false,
        external: ['ethers', 'js-kzg'],
        outDir: 'dist/node',
        outExtension({ format }) {
            return { js: format === 'esm' ? '.mjs' : '.cjs' };
        },
        esbuildOptions(options) {
            options.define = { 'process.env.NODE_ENV': '"production"' };
        },
    },

    {
        entry: ['src/node/file.ts'],
        format: ['esm', 'cjs'],
        platform: 'node',
        dts: true,
        clean: true,
        outDir: 'dist/node',
        outExtension({ format }) {
            return { js: format === 'esm' ? '.mjs' : '.cjs' }
        }
    }
]);
