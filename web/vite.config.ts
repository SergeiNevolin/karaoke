import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// свой uvicorn может жить на другом порту, если 8000 занят Go-бэком bebradio
const apiUrl = process.env.KARAOKE_API_URL || 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiUrl,
      '/songs': apiUrl,
    },
  },
})
