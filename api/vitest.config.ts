import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run tests sequentially — they share a database and ordering matters
    // for setup/teardown of tenant isolation data.
    fileParallelism: false,
  },
})
