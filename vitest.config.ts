import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    // Keep the suite light enough for a laptop: never more than two test workers.
    maxWorkers: 2,
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/cli/bin.ts'],
    },
  },
})
