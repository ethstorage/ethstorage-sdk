import { defineConfig } from 'tsup'

export default defineConfig([
    {
        entry: ['src/index.js'],
        sourcemap: true,
        clean: true,
        minify: false,
        format: ["cjs", "esm"]
    },
])
