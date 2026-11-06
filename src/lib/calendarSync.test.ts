/**
 * Googleカレンダー同期のテスト（APIモック）。
 * 本物の calendar.ts（HTTP 呼び出し・エラー分類・PATCH→POST→409 の流れ）と同期エンジンを、
 * 偽の Google Calendar サーバー（fetch モック）と偽の DB（ユーザーごとに分離＝RLS 相当）で動かす。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __test, googleCalendarApi } from './calendar'
import { buildEvent, countPending, eventIdFor, MAX_AUTO_RETRY, runSync, type SyncStore } from './calendarSync'
import type { CalendarLink, GoogleAccount, Task } from './types'

const TODAY = '2026-11-06'
const YUSA = 'u-yusa', SHOKO = 'u-shoko', BOSS = 'u-boss'
const EMAIL: Record<string, string> = { [YUSA]: 'yusa@gmail.com', [SHOKO]: 'shoko@gmail.com', [BOSS]: 'boss@gmail.com' }

// ---------- 偽 Google（calendar.app.created 相当: 自分が作ったカレンダーしか見えない） ----------
interface GEvent { body: Record<string, unknown>; status: 'confirmed' | 'cancelled' }
class FakeGoogle {
  calendars = new Map<string, { owner: string; events: Map<string, GEvent> }>()
  tokens = new Map<string, { email: string; expired?: boolean }>()
  calls = 0
  failNext: { status: number; body?: string; count: number } | null = null
  seq = 0

  events(email: string) {
    const out: { cal: string; id: string; summary: string; status: string }[] = []
    for (const [cid, c] of this.calendars) if (c.owner === email) for (const [id, e] of c.events) out.push({ cal: cid, id, summary: String(e.body.summary), status: e.status })
    return out
  }
  live(email: string) { return this.events(email).filter((e) => e.status === 'confirmed') }

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    this.calls++
    const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })
    if (this.failNext && this.failNext.count > 0) { this.failNext.count--; return new Response(this.failNext.body ?? '{}', { status: this.failNext.status }) }
    const tok = this.tokens.get((init.headers?.Authorization ?? '').replace('Bearer ', ''))
    if (!tok || tok.expired) return res(401, { error: { code: 401 } })
    const me = tok.email
    const path = new URL(url).pathname.replace('/calendar/v3', '')
    const m = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent) // calendars, {cid}, events, {eid}
    if (m === 'POST' && parts.length === 1) {
      const id = `cal-${++this.seq}@group.calendar.google.com`
      this.calendars.set(id, { owner: me, events: new Map() })
      return res(200, { id })
    }
    const c = this.calendars.get(parts[1])
    if (!c || c.owner !== me) return res(404, { error: { code: 404, message: 'Not Found' } }) // 他人のカレンダーは存在しないのと同じ
    if (parts.length === 2) {
      if (m === 'GET') return res(200, { id: parts[1] })
      if (m === 'DELETE') { this.calendars.delete(parts[1]); return res(204) }
    }
    if (parts.length === 3 && m === 'POST') {
      if (c.events.has(body.id)) return res(409, { error: { code: 409, message: 'The requested identifier already exists.' } })
      c.events.set(body.id, { body, status: 'confirmed' })
      return res(200, { id: body.id })
    }
    const ev = c.events.get(parts[3])
    if (m === 'PATCH') {
      if (!ev) return res(404, {})
      c.events.set(parts[3], { body: { ...ev.body, ...body }, status: body.status ?? ev.status })
      return res(200, { id: parts[3] })
    }
    if (m === 'DELETE') {
      if (!ev) return res(404, {})
      if (ev.status === 'cancelled') return res(410, {})
      ev.status = 'cancelled'
      return res(204)
    }
    return res(400, {})
  }
}

// ---------- 偽 DB（リンク・アカウントは本人分のみ読み書き＝RLS と同じ） ----------
class FakeDb {
  tasks: Task[] = []
  accounts = new Map<string, GoogleAccount>()
  links: CalendarLink[] = []
  storeFor(uid: string): SyncStore {
    return {
      getAccount: async () => this.accounts.get(uid) ?? null,
      claimCalendar: async (id) => { const a = this.accounts.get(uid)!; if (!a.calendar_id) a.calendar_id = id; return a.calendar_id },
      resetCalendar: async () => { this.accounts.get(uid)!.calendar_id = null },
      updateAccount: async (p) => { Object.assign(this.accounts.get(uid)!, p) },
      listLinks: async () => this.links.filter((l) => l.user_id === uid).map((l) => ({ ...l })),
      saveLink: async (l) => {
        if (l.user_id !== uid) throw new Error('RLS violation')
        this.links = this.links.filter((x) => !(x.task_id === l.task_id && x.user_id === uid)).concat({ ...l })
      },
      deleteLink: async (id) => { this.links = this.links.filter((x) => !(x.task_id === id && x.user_id === uid)) },
      fetchTasks: async (ids) => this.tasks.filter((t) => ids.includes(t.id)),
    }
  }
  link(uid: string) {
    this.accounts.set(uid, { user_id: uid, google_email: EMAIL[uid], calendar_id: null, status: 'active', last_sync_at: null, last_success_count: 0, last_failure_count: 0, last_error: null })
  }
}

let n = 0
const task = (p: Partial<Task>): Task => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, store_id: 's1', parent_id: null, title: 'タスク', description: '',
  assignee_id: null, priority: 'medium', category: 'general', due_date: TODAY, due_time: null, status: 'open', completed_at: null,
  completed_by: null, template_id: null, occurrence_date: null, created_by: BOSS, created_at: '', updated_at: '', deleted_at: null,
  assignment_mode: 'single', work_date: null, work_start: null, work_end: null, assignees: [], ...p,
})

let g: FakeGoogle
let db: FakeDb
const login = (uid: string, tokenValue = `tok-${uid}`) => { g.tokens.set(tokenValue, { email: EMAIL[uid] }); __test.setToken(uid, EMAIL[uid], tokenValue) }
const sync = (uid: string, extra: Partial<Parameters<typeof runSync>[0]> = {}) => {
  login(uid)
  return runSync({ uid, storeId: 's1', api: googleCalendarApi, store: db.storeFor(uid), tasks: db.tasks.filter((t) => !t.deleted_at), today: TODAY, verifyCalendar: true, ...extra })
}

beforeEach(() => {
  g = new FakeGoogle()
  db = new FakeDb()
  vi.stubGlobal('fetch', g.fetch)
  __test.setDelay(0)
  db.link(YUSA); db.link(SHOKO)
})

describe('スタッフごとのカレンダーへの同期', () => {
  it('YusaのタスクはYusaのカレンダーへ、ShokoのタスクはShokoのカレンダーへ（誤同期なし）', async () => {
    db.tasks.push(task({ title: 'Yusa作業', assignee_id: YUSA }), task({ title: 'Shoko作業', assignee_id: SHOKO }), task({ title: '未割当', assignee_id: null }))
    await sync(YUSA); await sync(SHOKO)
    expect(g.live(EMAIL[YUSA]).map((e) => e.summary)).toEqual(['Yusa作業'])
    expect(g.live(EMAIL[SHOKO]).map((e) => e.summary)).toEqual(['Shoko作業'])
    expect(db.links.every((l) => db.tasks.find((t) => t.id === l.task_id)!.assignee_id === l.user_id)).toBe(true)
  })

  it('編集しても重複予定は作られず、内容が更新される', async () => {
    const t = task({ title: '旧タイトル', assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    t.title = '新タイトル'; t.due_date = '2026-11-08'
    await sync(YUSA)
    const evs = g.live(EMAIL[YUSA])
    expect(evs).toHaveLength(1)
    expect(evs[0].summary).toBe('新タイトル')
    expect(evs[0].id).toBe(eventIdFor(t.id))
  })

  it('変更がなければ Google API を呼ばない（無料枠の節約）', async () => {
    db.tasks.push(task({ assignee_id: YUSA }))
    await sync(YUSA)
    const before = g.calls
    await sync(YUSA, { verifyCalendar: false })
    expect(g.calls).toBe(before)
  })

  it('院長がタスクを削除 → Yusaの次回同期で予定が削除される', async () => {
    const t = task({ assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    t.deleted_at = '2026-11-06T10:00:00Z' // 院長の端末で論理削除（Yusaの読込範囲外になる）
    const r = await sync(YUSA)
    expect(r.deleted).toBe(1)
    expect(g.live(EMAIL[YUSA])).toHaveLength(0)
    expect(db.links).toHaveLength(0)
  })

  it('物理削除されたタスクの予定も削除される', async () => {
    const t = task({ assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    db.tasks = []
    await sync(YUSA)
    expect(g.live(EMAIL[YUSA])).toHaveLength(0)
  })

  it('担当者変更 Yusa→Shoko: Yusaから消え、Shokoに追加される', async () => {
    const t = task({ title: '備品購入', assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    t.assignee_id = SHOKO
    await sync(SHOKO); await sync(YUSA)
    expect(g.live(EMAIL[YUSA])).toHaveLength(0)
    expect(g.live(EMAIL[SHOKO]).map((e) => e.summary)).toEqual(['備品購入'])
  })

  it('完了すると ✅ 完了 表示に更新、未完了に戻すと元に戻る', async () => {
    const t = task({ title: '日報', assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    t.status = 'done'
    await sync(YUSA)
    expect(g.live(EMAIL[YUSA])[0].summary).toBe('✅ 完了 日報')
    t.status = 'open'
    await sync(YUSA)
    expect(g.live(EMAIL[YUSA])[0].summary).toBe('日報')
  })

  it('削除後に元に戻した（同じID）タスクも重複せず復活する', async () => {
    const t = task({ assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    t.deleted_at = 'x'; await sync(YUSA)
    t.deleted_at = null; await sync(YUSA)
    expect(g.live(EMAIL[YUSA])).toHaveLength(1)
    expect(g.events(EMAIL[YUSA])).toHaveLength(1)
  })
})

describe('全員向けタスク', () => {
  it('各自のカレンダーに入り、完了表示は本人の状態だけ', async () => {
    const t = task({ title: '日報提出', assignment_mode: 'everyone', assignees: [
      { user_id: YUSA, status: 'done', completed_at: 'x' }, { user_id: SHOKO, status: 'open', completed_at: null }] })
    db.tasks.push(t)
    await sync(YUSA); await sync(SHOKO)
    expect(g.live(EMAIL[YUSA])[0].summary).toBe('✅ 完了 日報提出')
    expect(g.live(EMAIL[SHOKO])[0].summary).toBe('日報提出')
  })
  it('対象外のスタッフには同期しない', async () => {
    db.tasks.push(task({ assignment_mode: 'everyone', assignees: [{ user_id: SHOKO, status: 'open', completed_at: null }] }))
    await sync(YUSA)
    expect(g.live(EMAIL[YUSA])).toHaveLength(0)
  })
})

describe('複数端末（同じスタッフのスマホとPC）', () => {
  it('同時に同期してもカレンダー・予定は1つずつ', async () => {
    db.tasks.push(task({ assignee_id: YUSA }), task({ assignee_id: YUSA }))
    login(YUSA)
    const a = runSync({ uid: YUSA, storeId: 's1', api: googleCalendarApi, store: db.storeFor(YUSA), tasks: db.tasks, today: TODAY, verifyCalendar: true })
    const b = runSync({ uid: YUSA, storeId: 's1', api: googleCalendarApi, store: db.storeFor(YUSA), tasks: db.tasks, today: TODAY, verifyCalendar: true })
    await Promise.all([a, b])
    const cals = [...g.calendars.values()].filter((c) => c.owner === EMAIL[YUSA])
    expect(cals).toHaveLength(1) // 後から作られた方は削除される
    expect(g.live(EMAIL[YUSA])).toHaveLength(2)
  })
})

describe('エラー・期限切れ', () => {
  it('アクセストークン期限切れ → 再認証が必要と記録し中断。再接続後に反映', async () => {
    db.tasks.push(task({ assignee_id: YUSA }))
    login(YUSA)
    g.tokens.get(`tok-${YUSA}`)!.expired = true
    const r = await runSync({ uid: YUSA, storeId: 's1', api: googleCalendarApi, store: db.storeFor(YUSA), tasks: db.tasks, today: TODAY })
    expect(r.stopped).toBe('auth')
    expect(r.message).toContain('再接続')
    expect(db.accounts.get(YUSA)!.status).toBe('reauth_required')
    const r2 = await sync(YUSA) // 新しいトークンで再接続
    expect(r2.synced).toBe(1)
    expect(db.accounts.get(YUSA)!.status).toBe('active')
  })

  it('利用制限(429) → 中断し失敗を記録。タスクデータは変更されない', async () => {
    const t = task({ assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    t.title = '変更'
    g.failNext = { status: 429, count: 99 }
    const snapshot = JSON.stringify(db.tasks)
    const r = await sync(YUSA, { verifyCalendar: false })
    expect(r.stopped).toBe('rate_limit')
    expect(JSON.stringify(db.tasks)).toBe(snapshot)
    expect(db.links[0].sync_status).toBe('error')
    g.failNext = null
    await sync(YUSA)
    expect(g.live(EMAIL[YUSA])[0].summary).toBe('変更')
  })

  it(`一時的な失敗は自動再試行、${MAX_AUTO_RETRY}回失敗後は手動（今すぐ同期）で再試行`, async () => {
    db.tasks.push(task({ assignee_id: YUSA }))
    await sync(YUSA) // カレンダー作成のみ成功させるため一旦同期
    db.tasks.push(task({ title: '失敗するタスク', assignee_id: YUSA }))
    for (let i = 0; i < MAX_AUTO_RETRY; i++) { g.failNext = { status: 500, count: 1 }; await sync(YUSA, { verifyCalendar: false }) }
    const before = g.calls
    await sync(YUSA, { verifyCalendar: false })
    expect(g.calls).toBe(before) // 自動では呼ばない
    const r = await sync(YUSA, { verifyCalendar: false, force: true })
    expect(r.synced).toBe(1)
  })

  it('Google側でカレンダーが削除されていたら作り直して全件反映', async () => {
    db.tasks.push(task({ assignee_id: YUSA }))
    await sync(YUSA)
    g.calendars.clear()
    await sync(YUSA)
    expect(g.live(EMAIL[YUSA])).toHaveLength(1)
  })

  it('別アカウントのカレンダーIDを指されても書き込めない（404扱い→作り直し）', async () => {
    db.tasks.push(task({ assignee_id: SHOKO }))
    await sync(SHOKO)
    const shokoCal = db.accounts.get(SHOKO)!.calendar_id!
    db.accounts.get(YUSA)!.calendar_id = shokoCal // 万一取り違えても
    db.tasks.push(task({ assignee_id: YUSA }))
    await sync(YUSA)
    expect(g.calendars.get(shokoCal)!.events.size).toBe(1) // Shokoのカレンダーは無傷
    expect(g.live(EMAIL[YUSA])).toHaveLength(1)
  })

  it('未反映件数はトークンなしで数えられる', () => {
    db.tasks.push(task({ assignee_id: YUSA }), task({ assignee_id: SHOKO }))
    expect(countPending(YUSA, null, db.tasks, [], TODAY)).toBe(1)
  })

  it('30日より古い未同期タスクは新規作成しない', async () => {
    db.tasks.push(task({ assignee_id: YUSA, due_date: '2026-09-01' }))
    const r = await sync(YUSA)
    expect(r.synced).toBe(0)
  })
})

describe('予定の表示形式', () => {
  it('日付のみ → 終日', () => {
    const b = buildEvent(task({ assignee_id: YUSA }), YUSA)
    expect(b.start).toEqual({ date: TODAY }); expect(b.end).toEqual({ date: '2026-11-07' }); expect(b.transparency).toBe('transparent')
  })
  it('締切時刻 → 終日予定に「⏰18:00締切」（30分予定にしない）', () => {
    const b = buildEvent(task({ title: '月次報告', due_time: '18:00' }), YUSA)
    expect(b.summary).toBe('⏰18:00締切 月次報告'); expect(b.start.date).toBe(TODAY)
  })
  it('作業時間 → その時間帯に予定、締切は件名と説明に併記', () => {
    const b = buildEvent(task({ title: '撮影', due_date: '2026-11-10', due_time: '18:00', work_date: '2026-11-08', work_start: '10:00', work_end: '12:00' }), YUSA)
    expect(b.start).toEqual({ dateTime: '2026-11-08T10:00:00', timeZone: 'Asia/Tokyo' })
    expect(b.end.dateTime).toBe('2026-11-08T12:00:00')
    expect(b.summary).toBe('⏰11/10 18:00締切 撮影')
    expect(b.description).toContain('期限: 11/10 18:00')
  })
  it('優先度 高 → ‼ と赤色 / 完了 → ✅ 完了 と緑色', () => {
    expect(buildEvent(task({ title: 'A', priority: 'high' }), YUSA)).toMatchObject({ summary: '‼ A', colorId: '11' })
    expect(buildEvent(task({ title: 'A', priority: 'high', status: 'done' }), YUSA)).toMatchObject({ summary: '✅ 完了 A', colorId: '10' })
  })
  it('予定IDは Google の形式（a-v, 0-9）', () => {
    expect(eventIdFor('0f8e2a4c-1b3d-4e5f-9a7b-c6d8e0f1a2b3')).toMatch(/^[a-v0-9]{5,1024}$/)
  })
})
