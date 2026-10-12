import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@muxpad/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
