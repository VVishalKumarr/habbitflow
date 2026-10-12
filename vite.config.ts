import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The site uses real paths (/dashboard, /help/…), so assets need an absolute base:
//   '/'           – local dev, Capacitor (Android), a custom domain
//   '/habbitflow/' – GitHub Pages project site (set VITE_BASE_PATH in the workflow)
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const base = (process.env.VITE_BASE_PATH || env.VITE_BASE_PATH || '/').replace(/\/?$/, '/')
  return {
    base,
    plugins: [react(), tailwindcss()],
    build: {
      chunkSizeWarningLimit: 900,
    },
  }
})
