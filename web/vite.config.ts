/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // The build goes to web/dist, which the headless server (server/src/config.ts) and the desktop
  // shell (desktop/src/lib/paths.ts, electron-builder.yml) serve.
  build: { outDir: 'dist' },
  server: {
    port: 5173,
    // `npm run dev` in server/ listens on 127.0.0.1:8000. `npm run dev:mock` answers /api from MSW
    // in the browser, so it needs no server.
    proxy: {
      '/api': process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
