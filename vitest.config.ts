import { defineConfig } from 'vitest/config';

// TODO-someday(joel for crouton): why does this spec differ from tsconfig.test.json?
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.{test,spec}.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
    passWithNoTests: true,
  },
});
