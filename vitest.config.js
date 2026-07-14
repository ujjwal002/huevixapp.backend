import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.js'],
      exclude: ['src/**/*.test.js', 'src/server.js'],
      // Deliberately LOW to start — CI won't fail today, and you raise these
      // as you add the tests in the plan below. Ratcheting > a big-bang target.
      thresholds: { lines: 40, functions: 40, branches: 30, statements: 40 },
    },
  },
});