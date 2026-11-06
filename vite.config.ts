import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // GitHub Pages ではリポジトリ名のサブパス、Cloudflare Pages / ローカルでは "/"
  base: process.env.BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
})
