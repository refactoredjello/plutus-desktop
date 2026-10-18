import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Tests never schedule syncs or reach a real LLM.
    env: {
      ENVIRONMENT: 'test',
      SCHEDULER_ENABLED: 'false',
      LLM_PROVIDER: 'fake',
      // today() is the local date; a fixed zone keeps tests that read the real clock deterministic.
      TZ: 'UTC',
    },
  },
})
