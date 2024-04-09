import { defineConfig } from 'tsup'

export default defineConfig([
    {
        entry: ['src/index.js'],
        sourcemap: true,
        clean: true,
        minify: false,
        format: ["cjs", "esm"]
    },
    {
        entry: ['src/file/file.js'],
        sourcemap: true,
        clean: true,
        minify: false,
        format: ["cjs"]
    },
    {
        entry: ['src/file/file-browser.js'],
        sourcemap: true,
        clean: true,
        minify: false,
        format: ["esm"]
    }
])
