/**
 * Supabase Edge Function「naoru-google」の本体（Deno / Node 共通。window・import.meta.env を使わない）。
 * Googleカレンダーへの自動同期をサーバー側で行う。
 *
 * 安全設計
 * - Google のリフレッシュトークンは AES-GCM で暗号化して保存。鍵はサービスロールキーから HKDF で導出（DBだけ漏れても復号不可）
 * - ユーザー操作（connect / sync / disconnect / kick）は Supabase のログイン JWT を検証し、本人の分だけ処理
 * - 定期実行（cron）は DB 内に生成した合言葉ヘッダーで認証
 * - 同期処理はブラウザ版と同じ runSync を使う（本人担当のタスクのみ・本人のアプリ専用カレンダーのみ）
 */
import { createCalendarApi } from '../lib/calendarApi.ts'
import { friendlyError, runSync, type SyncResult, type SyncStore } from '../lib/calendarSync.ts'
import { todayStr } from '../lib/dates.ts'
import type { CalendarLink, GoogleAccount, Task } from '../lib/types.ts'
import { dueMessage, dueSummary } from '../lib/notify.ts'
import { generateVapidKeys, sendPush, type PushSubscriptionRow, type VapidKeys } from './webpush.ts'

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const MAX_USERS_PER_RUN = 50

// ---------- DB アクセス（本番は supabaseServerDb.ts、テストはメモリ上の偽物） ----------
export interface ServerAccount extends GoogleAccount {
  server_sync: boolean
  needs_sync: boolean
}
export interface ServerDb {
  /** ログイン JWT からユーザーID（無効なら null） */
  userIdFromJwt(jwt: string): Promise<string | null>
  cronSecret(): Promise<string | null>
  getAccount(uid: string): Promise<ServerAccount | null>
  saveAccount(uid: string, patch: Partial<ServerAccount>): Promise<void>
  claimCalendar(uid: string, calendarId: string): Promise<string>
  deleteAccount(uid: string): Promise<void>
  getToken(uid: string): Promise<{ enc_refresh_token: string; google_email: string } | null>
  saveToken(uid: string, enc: string, email: string): Promise<void>
  deleteToken(uid: string): Promise<void>
  listLinks(uid: string): Promise<CalendarLink[]>
  saveLink(uid: string, link: CalendarLink): Promise<void>
  deleteLink(uid: string, taskId: string): Promise<void>
  deleteAllLinks(uid: string): Promise<void>
  /** 本人が有効メンバーの店舗の、未完了＋直近完了のタスク（削除済み除く） */
  tasksForUser(uid: string): Promise<Task[]>
  tasksByIds(ids: string[]): Promise<Task[]>
  /** 本人として完了にする（全員・選んだメンバーのタスクは本人の分） */
  completeTask(uid: string, task: Task): Promise<Task>
  /** 同期が必要なユーザー（onlyUsers 指定時はその中から） */
  accountsToSync(staleMinutes: number, limit: number, onlyUsers?: string[]): Promise<string[]>
  /** 同じ店舗のメンバー（kick 用） */
  usersInSameStores(uid: string): Promise<string[]>
  // ----- 通知（Web Push） -----
  getConfig(key: string): Promise<string | null>
  /** 未設定のときだけ保存し、最終的な値を返す（同時実行対策） */
  setConfigIfMissing(key: string, value: string): Promise<string>
  listPushSubscriptions(uid?: string): Promise<PushSubscriptionRow[]>
  deletePushSubscription(endpoint: string): Promise<void>
}

export interface ServerEnv {
  db: ServerDb
  googleClientId: string
  googleClientSecret: string
  /** 暗号鍵の素材（サービスロールキー） */
  keyMaterial: string
  allowedOrigins: string[]
  fetchFn?: typeof fetch
  requestDelayMs?: number
}

// ---------- 暗号化 ----------
const enc = new TextEncoder()
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function deriveKey(material: string) {
  const base = await crypto.subtle.importKey('raw', enc.encode(material), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('naoru-google-token'), info: enc.encode('v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}
export async function encryptToken(plain: string, material: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(material), enc.encode(plain)))
  return `v1:${b64(iv)}:${b64(ct)}`
}
export async function decryptToken(stored: string, material: string) {
  const [v, iv, ct] = stored.split(':')
  if (v !== 'v1' || !iv || !ct) throw new Error('unknown token format')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await deriveKey(material), unb64(ct))
  return new TextDecoder().decode(pt)
}

// ---------- Google OAuth ----------
class ReauthError extends Error {}

async function tokenRequest(env: ServerEnv, params: Record<string, string>) {
  const f = env.fetchFn ?? fetch
  const r = await f(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.googleClientId, client_secret: env.googleClientSecret, ...params }).toString(),
  })
  const j = await r.json().catch(() => ({})) as Record<string, string>
  if (!r.ok) {
    if (j.error === 'invalid_grant' || j.error === 'unauthorized_client') throw new ReauthError(j.error)
    throw new Error(`Google token error ${r.status} ${j.error ?? ''}`)
  }
  return j
}

async function fetchEmail(env: ServerEnv, accessToken: string) {
  const f = env.fetchFn ?? fetch
  const r = await f('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })
  const j = await r.json().catch(() => ({})) as { email?: string }
  return (j.email ?? '').toLowerCase()
}

// ---------- 1ユーザー分の同期 ----------
function storeFor(db: ServerDb, uid: string): SyncStore {
  return {
    getAccount: () => db.getAccount(uid),
    claimCalendar: (id) => db.claimCalendar(uid, id),
    resetCalendar: () => db.saveAccount(uid, { calendar_id: null }),
    updateAccount: (p) => db.saveAccount(uid, p),
    listLinks: () => db.listLinks(uid),
    saveLink: (l) => db.saveLink(uid, { ...l, user_id: uid }),
    deleteLink: (id) => db.deleteLink(uid, id),
    fetchTasks: (ids) => db.tasksByIds(ids),
    completeTask: (t) => db.completeTask(uid, t),
  }
}

async function accessTokenFor(env: ServerEnv, uid: string): Promise<string | null> {
  const tok = await env.db.getToken(uid)
  if (!tok) return null
  let refresh: string
  try {
    refresh = await decryptToken(tok.enc_refresh_token, env.keyMaterial)
  } catch {
    throw new ReauthError('decrypt') // サーバーの鍵が変わった等 → 本人に再認証してもらう
  }
  const j = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refresh })
  return j.access_token
}

export async function syncUser(env: ServerEnv, uid: string, force = false): Promise<SyncResult | { skipped: string }> {
  const { db } = env
  await db.saveAccount(uid, { needs_sync: false }) // 同期中の変更は再度 true になる
  let access: string | null
  try {
    access = await accessTokenFor(env, uid)
  } catch (e) {
    if (e instanceof ReauthError) {
      await db.saveAccount(uid, { status: 'reauth_required', last_error: 'Googleとの連携が切れました。「設定」→「Googleカレンダー連携」で「再認証」を押してください。' })
      return { skipped: 'reauth' }
    }
    throw e
  }
  if (!access) return { skipped: 'no_token' }
  const api = createCalendarApi(() => access!, { delayMs: () => env.requestDelayMs ?? 100, fetchFn: env.fetchFn })
  const tasks = await db.tasksForUser(uid)
  return runSync({ uid, storeId: '', api, store: storeFor(db, uid), tasks, today: todayStr('Asia/Tokyo'), verifyCalendar: true, force })
}

// ---------- 通知（Web Push） ----------
export const PUSH_SUBJECT = 'https://yucha922-cyber.github.io/NAORU-task/'

/** VAPID 鍵（初回に自動生成し、秘密鍵は暗号化して private_config に保存） */
async function vapidKeys(env: ServerEnv): Promise<VapidKeys> {
  const stored = await env.db.getConfig('vapid_keys')
  if (stored) return JSON.parse(await decryptToken(stored, env.keyMaterial)) as VapidKeys
  const fresh = await generateVapidKeys()
  const winner = await env.db.setConfigIfMissing('vapid_keys', await encryptToken(JSON.stringify(fresh), env.keyMaterial))
  return JSON.parse(await decryptToken(winner, env.keyMaterial)) as VapidKeys
}

/** 期限が近いタスクの通知を本人の全端末へ送る。戻り値: 送信できた端末数 */
async function pushDueSummary(env: ServerEnv, uid: string, subs: PushSubscriptionRow[], keys: VapidKeys, test = false) {
  const s = dueSummary(await env.db.tasksForUser(uid), uid, todayStr('Asia/Tokyo'))
  const m = dueMessage(s)
  if (!m && !test) return 0
  const payload = m
    ? { ...m, badge: s.total, tag: 'naoru-daily', url: './' }
    : { title: 'NAORU TASK', body: '通知のテストです。期限が近いタスクはありません。', badge: 0, tag: 'naoru-test', url: './' }
  let sent = 0
  for (const sub of subs) {
    const r = await sendPush(sub, payload, keys, PUSH_SUBJECT, env.fetchFn)
    if (r === 'ok') sent++
    if (r === 'gone') await env.db.deletePushSubscription(sub.endpoint) // 解除・アプリ削除された端末
  }
  return sent
}

// ---------- HTTP ----------
function cors(req: Request, env: ServerEnv) {
  const origin = req.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': env.allowedOrigins.includes(origin) ? origin : env.allowedOrigins[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}
const json = (req: Request, env: ServerEnv, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req, env), 'Content-Type': 'application/json' } })

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export async function handleRequest(req: Request, env: ServerEnv): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req, env) })
  if (req.method !== 'POST') return json(req, env, { error: 'method not allowed' }, 405)
  let body: { action?: string; code?: string }
  try { body = await req.json() } catch { return json(req, env, { error: 'invalid body' }, 400) }
  const { db } = env

  try {
    // ----- 定期実行（5分ごと） -----
    if (body.action === 'cron') {
      const secret = await db.cronSecret()
      const given = req.headers.get('x-naoru-cron') ?? ''
      if (!secret || !safeEqual(given, secret)) return json(req, env, { error: 'forbidden' }, 403)
      const users = await db.accountsToSync(15, MAX_USERS_PER_RUN)
      const results: Record<string, string> = {}
      for (const uid of users) {
        try { const r = await syncUser(env, uid); results[uid] = 'skipped' in r ? r.skipped : `ok(${r.synced}/${r.deleted}/${r.failed})` }
        catch (e) { results[uid] = `error: ${(e as Error).message}` }
      }
      return json(req, env, { users: users.length, results })
    }

    if (body.action === 'ping') return json(req, env, { ok: true, version: 2 })

    // 通知用の公開鍵（公開して問題ない値）
    if (body.action === 'push-key') return json(req, env, { publicKey: (await vapidKeys(env)).publicKey })

    // 毎朝の通知（定期実行）
    if (body.action === 'push-daily') {
      const secret = await db.cronSecret()
      const given = req.headers.get('x-naoru-cron') ?? ''
      if (!secret || !safeEqual(given, secret)) return json(req, env, { error: 'forbidden' }, 403)
      const keys = await vapidKeys(env)
      const byUser = new Map<string, PushSubscriptionRow[]>()
      for (const s of await db.listPushSubscriptions()) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s])
      let sent = 0
      for (const [u, subs] of byUser) { try { sent += await pushDueSummary(env, u, subs, keys) } catch { /* 次の人へ */ } }
      return json(req, env, { users: byUser.size, sent })
    }

    // ----- ここから先はログインユーザー本人の操作 -----
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const uid = jwt ? await db.userIdFromJwt(jwt) : null
    if (!uid) return json(req, env, { error: 'ログインが必要です' }, 401)

    if (body.action === 'connect') {
      if (!body.code) return json(req, env, { error: 'code がありません' }, 400)
      let t: Record<string, string>
      try {
        t = await tokenRequest(env, { grant_type: 'authorization_code', code: body.code, redirect_uri: 'postmessage' })
      } catch {
        return json(req, env, { error: 'Googleとの連携を完了できませんでした。もう一度「Googleアカウントと連携する」を押してください。' }, 400)
      }
      if (!(t.scope ?? '').split(' ').includes(CALENDAR_SCOPE)) {
        return json(req, env, { error: 'カレンダーへのアクセスが許可されませんでした。もう一度連携し、カレンダーのチェックをオンにしてください。' }, 400)
      }
      const email = await fetchEmail(env, t.access_token)
      if (!email) return json(req, env, { error: 'Googleアカウントを確認できませんでした。もう一度お試しください。' }, 400)
      const current = await db.getAccount(uid)
      if (current?.google_email && current.google_email.toLowerCase() !== email && current.status !== 'disconnected') {
        return json(req, env, { error: `別のGoogleアカウント（${email}）が選ばれました。連携済みのアカウント（${current.google_email}）を選んでください。` }, 400)
      }
      const existing = await db.getToken(uid)
      if (!t.refresh_token && !existing) {
        return json(req, env, { error: '自動同期の許可を取得できませんでした。https://myaccount.google.com/permissions で「NAORU TASK」のアクセスを削除してから、もう一度連携してください。' }, 400)
      }
      if (t.refresh_token) await db.saveToken(uid, await encryptToken(t.refresh_token, env.keyMaterial), email)
      await db.saveAccount(uid, { google_email: email, status: 'active', server_sync: true, needs_sync: true, last_error: null })
      const r = await syncUser(env, uid, true)
      return json(req, env, { email, result: r })
    }

    if (body.action === 'push-test') {
      const subs = await db.listPushSubscriptions(uid)
      if (!subs.length) return json(req, env, { error: 'この端末の通知が登録されていません。「通知をオンにする」を押してください。' }, 400)
      const sent = await pushDueSummary(env, uid, subs, await vapidKeys(env), true)
      return json(req, env, { sent })
    }

    if (body.action === 'sync') {
      const r = await syncUser(env, uid, true)
      return json(req, env, { result: r })
    }

    // タスク変更直後: 同じ店舗で「要同期」のユーザーをすぐに同期（定期実行を待たずに反映）
    if (body.action === 'kick') {
      const users = await db.accountsToSync(Number.POSITIVE_INFINITY, 20, await db.usersInSameStores(uid))
      for (const u of users) { try { await syncUser(env, u) } catch { /* 次回の定期実行で再試行 */ } }
      return json(req, env, { users: users.length })
    }

    if (body.action === 'disconnect') {
      const account = await db.getAccount(uid)
      const tok = await db.getToken(uid)
      if (tok) {
        try {
          const access = await accessTokenFor(env, uid)
          if (access && account?.calendar_id) await createCalendarApi(() => access, { fetchFn: env.fetchFn }).deleteCalendar(account.calendar_id)
          const refresh = await decryptToken(tok.enc_refresh_token, env.keyMaterial)
          await (env.fetchFn ?? fetch)(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' })
        } catch { /* 取り消せなくてもアプリ側の連携情報は削除する */ }
      }
      await db.deleteToken(uid)
      await db.deleteAllLinks(uid)
      await db.deleteAccount(uid)
      return json(req, env, { ok: true })
    }

    return json(req, env, { error: 'unknown action' }, 400)
  } catch (e) {
    return json(req, env, { error: friendlyError(e) }, 500)
  }
}
