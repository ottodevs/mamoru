import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The SPA talks only to /api on its own origin; in dev that is `wrangler dev` on 8787.
const WORKER = 'http://localhost:8787'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  if (command === 'build' && env.VITE_FIXTURES === '1') {
    throw new Error('VITE_FIXTURES=1 is dev only. Fixtures never ship in the production build.')
  }
  return {
    plugins: [react(), tailwindcss()],
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
    server: {
      // The API refuses POSTs from a foreign Origin, so the proxy presents the Worker's own origin.
      proxy: env.VITE_FIXTURES === '1' ? undefined : { '/api': { target: WORKER, changeOrigin: true, headers: { origin: WORKER } } },
    },
  }
})
