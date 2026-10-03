import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2020', sourcemap: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as any);
