import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const serverSrc = fileURLToPath(new URL('../server/src/', import.meta.url))

export default defineConfig({
  resolve: {
    // Same mapping as the tsconfig paths: tests run the server's sources, no build needed.
    alias: [{ find: /^plutus-server\/dist\/(.*)$/, replacement: `${serverSrc}$1` }],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
