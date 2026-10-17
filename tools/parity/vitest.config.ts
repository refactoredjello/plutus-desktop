import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests only: nothing here starts either app or needs Postgres.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['*.test.ts'],
  },
})
