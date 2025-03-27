import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: ['src/index.ts'],
        format: ['esm', 'cjs'],
        platform: 'neutral',
        dts: true,
        sourcemap: true,
        clean: true,
        external: ['ethers', `js-kzg`],
        outExtension({format}) {
            return {js: format === 'esm' ? '.mjs' : '.cjs'}
        },
        esbuildOptions(options) {
            options.define = {'process.env.NODE_ENV': '"production"'}
        }
    },

    {
        entry: ['src/node/file.ts'],
        format: ['esm', 'cjs'],
        platform: 'node',
        dts: true,
        sourcemap: true,
        clean: true,
        outExtension({ format }) {
            return { js: format === 'esm' ? '.mjs' : '.cjs' }
        }
    }
]);
