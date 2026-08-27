import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The fake PJe server and the Postgres contract suites are slower than a unit test
    // but still far below the default CI budget; 30 s keeps a hung socket from wedging a run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: 'default',
  },
});
