import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A unit test that needs thirty seconds is a broken unit test. The end-to-end crawls are a
    // different animal — a full partition tree over a synthetic court, several hundred HTTP
    // round trips — and a CI runner is markedly slower than a laptop, so they get their own
    // budget rather than a global one that would hide a genuinely hung unit test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: 'default',
  },
});
