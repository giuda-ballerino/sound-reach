import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: { target: 'es2020', sourcemap: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
