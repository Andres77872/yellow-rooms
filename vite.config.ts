import { defineConfig, type Plugin } from 'vitest/config'
import { resolve } from 'node:path'

// Serve the editor at the clean /editor URL. Vite's multi-page build only
// knows /editor.html, so rewrite the pretty path in dev/preview; static hosts
// need the same rewrite (or users can hit /editor.html directly).
function editorRoute(): Plugin {
  const rewrite = (req: { url?: string }) => {
    if (req.url === '/editor' || req.url?.startsWith('/editor?')) {
      req.url = '/editor.html' + req.url.slice('/editor'.length)
    }
  }
  return {
    name: 'editor-route',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => { rewrite(req); next() })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => { rewrite(req); next() })
    },
  }
}

// https://vite.dev/config/
// Vanilla JS + Three.js app — no framework plugin needed.
export default defineConfig({
  plugins: [editorRoute()],
  build: {
    // The isolated three.js vendor chunk is ~610 kB minified on its own; the
    // limit sits just above it so the warning still flags app-code growth.
    chunkSizeWarningLimit: 650,
    rolldownOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        editor: resolve(__dirname, 'editor.html'),
      },
      output: {
        // Three.js is ~half of the shared payload and changes only on a
        // dependency bump. A dedicated vendor chunk keeps it browser-cached
        // across game/editor deploys instead of re-downloading it with every
        // world-gen change folded into the same file.
        codeSplitting: {
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
    // Several world-generation suites intentionally audit thousands of seeded
    // chunks. With the multilevel corpus running in parallel, slower CI hosts
    // can exceed Vitest's 5s per-test default without any stalled work.
    testTimeout: 15_000,
  },
})
