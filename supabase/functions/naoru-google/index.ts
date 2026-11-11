// Supabase Edge Function「naoru-google」— Googleカレンダー自動同期
// 設置方法: docs/SETUP.md「4. Googleカレンダーの自動同期」
// 本体のロジックは GitHub の公開リポジトリから「コミットを固定して」読み込む（内容が勝手に変わらない）。
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handleRequest } from 'https://raw.githubusercontent.com/yucha922-cyber/naoru-task/200eff35d84f5f728a9af470f06c73468dddc7ab/src/server/googleServer.ts'
import { createSupabaseServerDb } from 'https://raw.githubusercontent.com/yucha922-cyber/naoru-task/200eff35d84f5f728a9af470f06c73468dddc7ab/src/server/supabaseServerDb.ts'

const url = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createSupabaseServerDb(createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }))

Deno.serve((req) => handleRequest(req, {
  db,
  googleClientId: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
  googleClientSecret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
  keyMaterial: serviceKey,
  allowedOrigins: ['https://yucha922-cyber.github.io', 'http://localhost:5173'],
}))
