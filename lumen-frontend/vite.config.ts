import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev-only proxy: the browser talks to the Vite origin, Vite forwards to the
      // backend. This is the approved connectivity approach — no CORS headers or
      // dependency were added to the backend. The production CORS decision remains
      // deferred until deployment architecture itself is decided.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
