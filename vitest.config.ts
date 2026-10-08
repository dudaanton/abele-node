import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    testTimeout: 20000,
    setupFiles: ['tests/setup.ts'],
    maxWorkers: 2,
  },
})
