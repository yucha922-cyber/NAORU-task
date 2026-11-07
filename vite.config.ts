import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // GitHub Pages ではリポジトリ名のサブパス、Cloudflare Pages / ローカルでは "/"
  base: process.env.BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  // 設定画面に表示するバージョン（公開日時）。古い画面のままかを確認するため
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
})
