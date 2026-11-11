// Supabase Edge Function「naoru-google」— Googleカレンダー自動同期
// 設置方法: docs/SETUP.md「4. Googleカレンダーの自動同期」
// ・Supabase の画面ではファイル名「index.ts」はそのまま。関数名（Function name）を naoru-google にする
// ・本体のロジックは GitHub の公開リポジトリから「コミットを固定して」読み込む（内容が勝手に変わらない）
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handleRequest } from 'https://raw.githubusercontent.com/yucha922-cyber/naoru-task/7df0e82488a8f3fc0ddd06a6e4e70d567203cf60/src/server/googleServer.ts'
import { createSupabaseServerDb } from 'https://raw.githubusercontent.com/yucha922-cyber/naoru-task/7df0e82488a8f3fc0ddd06a6e4e70d567203cf60/src/server/supabaseServerDb.ts'

/** サーバー用の秘密キー（新方式 SUPABASE_SECRET_KEYS を優先し、無ければ旧方式） */
function serverKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
    if (typeof keys.default === 'string' && keys.default) return keys.default
  } catch { /* 旧方式へ */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}

const url = Deno.env.get('SUPABASE_URL')!
const key = serverKey()
const db = createSupabaseServerDb(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }))

Deno.serve((req) => handleRequest(req, {
  db,
  googleClientId: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
  googleClientSecret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
  keyMaterial: key, // 保存トークンの暗号鍵の素材（DB の中身だけでは復号できない）
  allowedOrigins: ['https://yucha922-cyber.github.io', 'http://localhost:5173'],
}))
