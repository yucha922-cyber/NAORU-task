/**
 * サーバー側自動同期（Edge Function「naoru-google」）のテスト。
 * 本物の handleRequest を、偽 Google（OAuth・Calendar）と偽 DB で動かす。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeGoogle } from '../lib/fakeGoogle.testutil'
import { eventIdFor } from '../lib/calendarSync'
import type { CalendarLink, Task } from '../lib/types'
import { decryptToken, encryptToken, handleRequest, type ServerAccount, type ServerDb, type ServerEnv } from './googleServer'

const YUSA = 'u-yusa', SHOKO = 'u-shoko', OUTSIDER = 'u-out'
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created openid email'
const KEY = 'service-role-key-for-test'
let n = 0
const task = (p: Partial<Task>): Task => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, store_id: 's1', parent_id: null, title: 'タスク', description: '',
  assignee_id: null, priority: 'medium', category: 'general', due_date: '2026-11-12', due_time: null, status: 'open', completed_at: null,
  completed_by: null, template_id: null, occurrence_date: null, created_by: YUSA, created_at: '', updated_at: '', deleted_at: null,
  assignment_mode: 'single', color_id: null, work_date: null, work_start: null, work_end: null, assignees: [], ...p,
})

class MemDb implements ServerDb {
  accounts = new Map<string, ServerAccount>()
  tokens = new Map<string, { enc_refresh_token: string; google_email: string }>()
  links: CalendarLink[] = []
  tasks: Task[] = []
  members: Record<string, string[]> = { s1: [YUSA, SHOKO], s2: [OUTSIDER] }
  jwts: Record<string, string> = { 'jwt-yusa': YUSA, 'jwt-shoko': SHOKO, 'jwt-out': OUTSIDER }
  secret = 'cron-secret'
  async userIdFromJwt(j: string) { return this.jwts[j] ?? null }
  async cronSecret() { return this.secret }
  async getAccount(uid: string) { return this.accounts.get(uid) ?? null }
  async saveAccount(uid: string, p: Partial<ServerAccount>) {
    const cur = this.accounts.get(uid) ?? { user_id: uid, google_email: null, calendar_id: null, status: 'active', last_sync_at: null, last_success_count: 0, last_failure_count: 0, last_error: null, server_sync: false, needs_sync: false }
    this.accounts.set(uid, { ...cur, ...p } as ServerAccount)
  }
  async claimCalendar(uid: string, id: string) { const a = this.accounts.get(uid)!; if (!a.calendar_id) a.calendar_id = id; return a.calendar_id }
  async deleteAccount(uid: string) { this.accounts.delete(uid) }
  async getToken(uid: string) { return this.tokens.get(uid) ?? null }
  async saveToken(uid: string, e: string, email: string) { this.tokens.set(uid, { enc_refresh_token: e, google_email: email }) }
  async deleteToken(uid: string) { this.tokens.delete(uid) }
  async listLinks(uid: string) { return this.links.filter((l) => l.user_id === uid).map((l) => ({ ...l })) }
  async saveLink(uid: string, l: CalendarLink) { this.links = this.links.filter((x) => !(x.task_id === l.task_id && x.user_id === uid)).concat({ ...l, user_id: uid }) }
  async deleteLink(uid: string, id: string) { this.links = this.links.filter((x) => !(x.task_id === id && x.user_id === uid)) }
  async deleteAllLinks(uid: string) { this.links = this.links.filter((x) => x.user_id !== uid) }
  async tasksForUser(uid: string) {
    const stores = Object.entries(this.members).filter(([, us]) => us.includes(uid)).map(([s]) => s)
    return this.tasks.filter((t) => stores.includes(t.store_id) && !t.deleted_at)
  }
  async tasksByIds(ids: string[]) { return this.tasks.filter((t) => ids.includes(t.id)) }
  async completeTask(uid: string, t: Task) {
    const cur = this.tasks.find((x) => x.id === t.id)!
    if (cur.assignment_mode !== 'single') cur.assignees = cur.assignees.map((a) => (a.user_id === uid ? { ...a, status: 'done', completed_at: 'x' } : a))
    else if (cur.assignee_id === uid) cur.status = 'done'
    return cur
  }
  async accountsToSync(stale: number, limit: number, only?: string[]) {
    return [...this.accounts.values()].filter((a) => a.server_sync && a.status !== 'disconnected' && (a.needs_sync || (Number.isFinite(stale) && !a.last_sync_at)))
      .filter((a) => !only || only.includes(a.user_id)).slice(0, limit).map((a) => a.user_id)
  }
  async usersInSameStores(uid: string) { return [...new Set(Object.values(this.members).filter((us) => us.includes(uid)).flat())] }
}

let g: FakeGoogle
let db: MemDb
let env: ServerEnv
const call = (action: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  handleRequest(new Request('https://x/functions/v1/naoru-google', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://yucha922-cyber.github.io', ...headers }, body: JSON.stringify({ action, ...extra }) }), env)
    .then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }))
const connect = (jwt: string, email: string, opts: { scope?: string; noRefresh?: boolean } = {}) => {
  const code = `code-${email}-${Math.random()}`
  g.codes.set(code, { email, scope: opts.scope ?? SCOPE, noRefresh: opts.noRefresh })
  return call('connect', { code }, { Authorization: `Bearer ${jwt}` })
}

beforeEach(() => {
  g = new FakeGoogle()
  db = new MemDb()
  env = { db, googleClientId: 'cid', googleClientSecret: 'secret', keyMaterial: KEY, allowedOrigins: ['https://yucha922-cyber.github.io'], fetchFn: g.fetch as unknown as typeof fetch, requestDelayMs: 0 }
})

describe('暗号化', () => {
  it('リフレッシュトークンは暗号化され、正しい鍵でのみ復号できる', async () => {
    const e = await encryptToken('ref-secret-123', KEY)
    expect(e).not.toContain('ref-secret')
    expect(await decryptToken(e, KEY)).toBe('ref-secret-123')
    await expect(decryptToken(e, 'other-key')).rejects.toThrow()
  })
})

describe('連携（connect）', () => {
  it('連携するとトークンを暗号化保存し、すぐに本人のタスクを本人のカレンダーへ反映', async () => {
    db.tasks.push(task({ title: 'Yusaの作業', assignee_id: YUSA }), task({ title: 'Shokoの作業', assignee_id: SHOKO }))
    const r = await connect('jwt-yusa', 'yusa@gmail.com')
    expect(r.status).toBe(200)
    expect(r.body.email).toBe('yusa@gmail.com')
    expect(db.tokens.get(YUSA)!.enc_refresh_token).toMatch(/^v1:/)
    expect(db.tokens.get(YUSA)!.enc_refresh_token).not.toContain('ref-')
    expect(db.accounts.get(YUSA)).toMatchObject({ server_sync: true, status: 'active' })
    expect(g.live('yusa@gmail.com').map((e) => e.summary)).toEqual(['Yusaの作業'])
  })
  it('ログインしていない / 無効な JWT は拒否', async () => {
    expect((await call('connect', { code: 'x' })).status).toBe(401)
    expect((await call('sync', {}, { Authorization: 'Bearer forged' })).status).toBe(401)
  })
  it('カレンダーの許可がなければ拒否', async () => {
    const r = await connect('jwt-yusa', 'yusa@gmail.com', { scope: 'openid email' })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('カレンダー')
    expect(db.tokens.has(YUSA)).toBe(false)
  })
  it('連携済みと別の Google アカウントは拒否（誤同期防止）', async () => {
    await connect('jwt-yusa', 'yusa@gmail.com')
    const r = await connect('jwt-yusa', 'shoko@gmail.com')
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('別のGoogleアカウント')
  })
  it('リフレッシュトークンが得られない場合は手順を案内', async () => {
    const r = await connect('jwt-yusa', 'yusa@gmail.com', { noRefresh: true })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('myaccount.google.com/permissions')
  })
})

describe('自動同期（cron / kick）', () => {
  it('アプリを閉じていても: タスク変更 → 定期実行で反映（他の人が変更・削除・担当変更しても）', async () => {
    const t = task({ title: '旧', assignee_id: YUSA }); db.tasks.push(t)
    await connect('jwt-yusa', 'yusa@gmail.com')
    await connect('jwt-shoko', 'shoko@gmail.com')
    // 院長がタスクを編集 → DB トリガーが needs_sync を立てる（ここでは手動で再現）
    t.title = '新'; t.assignee_id = SHOKO
    db.accounts.get(YUSA)!.needs_sync = true; db.accounts.get(SHOKO)!.needs_sync = true
    const r = await call('cron', {}, { 'x-naoru-cron': 'cron-secret' })
    expect(r.status).toBe(200)
    expect(r.body.users).toBe(2)
    expect(g.live('yusa@gmail.com')).toHaveLength(0)
    expect(g.live('shoko@gmail.com').map((e) => e.summary)).toEqual(['新'])
    expect(db.accounts.get(SHOKO)!.needs_sync).toBe(false)
  })
  it('定期実行は合言葉がないと拒否', async () => {
    expect((await call('cron', {}, { 'x-naoru-cron': 'wrong' })).status).toBe(403)
    expect((await call('cron')).status).toBe(403)
  })
  it('kick は同じ店舗のユーザーだけを同期（他店舗は対象外）', async () => {
    db.tasks.push(task({ assignee_id: SHOKO }), task({ store_id: 's2', assignee_id: OUTSIDER }))
    await connect('jwt-shoko', 'shoko@gmail.com')
    await connect('jwt-out', 'out@gmail.com')
    db.accounts.get(SHOKO)!.needs_sync = true; db.accounts.get(OUTSIDER)!.needs_sync = true
    const r = await call('kick', {}, { Authorization: 'Bearer jwt-yusa' })
    expect(r.body.users).toBe(1)
    expect(db.accounts.get(OUTSIDER)!.needs_sync).toBe(true)
  })
  it('Google側の完了操作もサーバーが取り込む', async () => {
    const t = task({ title: '完了テスト', assignee_id: YUSA }); db.tasks.push(t)
    await connect('jwt-yusa', 'yusa@gmail.com')
    for (const c of g.calendars.values()) { const e = c.events.get(eventIdFor(t.id)); if (e) Object.assign(e.body, { colorId: '8' }) }
    db.accounts.get(YUSA)!.needs_sync = true
    await call('cron', {}, { 'x-naoru-cron': 'cron-secret' })
    expect(t.status).toBe('done')
  })
  it('Google 側で許可を取り消された → 再認証が必要と記録（タスクは無傷）', async () => {
    db.tasks.push(task({ assignee_id: YUSA }))
    await connect('jwt-yusa', 'yusa@gmail.com')
    g.refreshTokens.clear()
    db.accounts.get(YUSA)!.needs_sync = true
    await call('cron', {}, { 'x-naoru-cron': 'cron-secret' })
    expect(db.accounts.get(YUSA)!.status).toBe('reauth_required')
    expect(db.accounts.get(YUSA)!.last_error).toContain('再認証')
  })
})

describe('連携解除（disconnect）', () => {
  it('カレンダー削除・Googleの許可取り消し・トークン/リンク/アカウント削除', async () => {
    db.tasks.push(task({ assignee_id: YUSA }))
    await connect('jwt-yusa', 'yusa@gmail.com')
    expect(g.refreshTokens.size).toBe(1)
    const r = await call('disconnect', {}, { Authorization: 'Bearer jwt-yusa' })
    expect(r.status).toBe(200)
    expect([...g.calendars.values()].filter((c) => c.owner === 'yusa@gmail.com')).toHaveLength(0)
    expect(g.refreshTokens.size).toBe(0)
    expect(db.tokens.has(YUSA)).toBe(false)
    expect(db.links.filter((l) => l.user_id === YUSA)).toHaveLength(0)
    expect(db.accounts.has(YUSA)).toBe(false)
  })
})

describe('CORS', () => {
  it('許可したサイトからのみ', async () => {
    const r = await call('ping')
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://yucha922-cyber.github.io')
  })
})
