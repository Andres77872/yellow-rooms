import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
// Vanilla JS + Three.js app — no framework plugin needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})
