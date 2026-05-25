import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.{test,spec}.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
    passWithNoTests: true,
  },
});
