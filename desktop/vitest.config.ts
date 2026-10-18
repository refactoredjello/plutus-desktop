import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Same as the tsconfig: plutus-server resolves to its sources through the "plutus-source"
  // export condition, so tests need no server build. The rest are Vite's server defaults.
  ssr: { resolve: { conditions: ['plutus-source', 'module', 'node', 'development|production'] } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
