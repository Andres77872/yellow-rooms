import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
// Vanilla JS + Three.js app — no framework plugin needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
    // Several world-generation suites intentionally audit thousands of seeded
    // chunks. With the multilevel corpus running in parallel, slower CI hosts
    // can exceed Vitest's 5s per-test default without any stalled work.
    testTimeout: 15_000,
  },
})
