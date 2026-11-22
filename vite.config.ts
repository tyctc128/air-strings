import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages).
  base: './',
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
