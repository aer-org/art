import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    testTimeout: 600_000, // 10 min per test
    hookTimeout: 300_000, // 5 min setup/teardown
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
