import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Mirrors api/tests/conftest.py: tests never schedule syncs or reach a real LLM.
    env: {
      ENVIRONMENT: 'test',
      SCHEDULER_ENABLED: 'false',
      LLM_PROVIDER: 'fake',
    },
  },
})
