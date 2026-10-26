import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    /* Node environment: nothing here touches the DOM. The browser-level checks
     * live in Playwright (see TESTING.md, layer 4). */
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    /* Migration tests spawn the real migrate script, which takes a second or
     * two each. */
    testTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
