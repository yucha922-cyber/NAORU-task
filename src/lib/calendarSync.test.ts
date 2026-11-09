/**
 * Googleカレンダー同期のテスト（APIモック）。
 * 本物の calendar.ts（HTTP 呼び出し・エラー分類・PATCH→POST→409 の流れ）と同期エンジンを、
 * 偽の Google Calendar サーバー（fetch モック）と偽の DB（ユーザーごとに分離＝RLS 相当）で動かす。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __test, googleCalendarApi } from './calendar'
import { buildEvent, countPending, eventIdFor, isDoneMarker, MAX_AUTO_RETRY, runSync, type SyncStore } from './calendarSync'
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
  /** Google カレンダー上での見え方（date があれば終日として表示される） */
  shownAs(email: string) {
    return [...this.calendars.values()].filter((c) => c.owner === email).flatMap((c) => [...c.events.values()]).map((e) => {
      const st = e.body.start as { date?: string; dateTime?: string }
      return st.date ? `終日 ${st.date}` : `時間 ${st.dateTime}`
    })
  }

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
    if (parts.length === 3 && m === 'GET') {
      const items = [...c.events.entries()].filter(([, e]) => e.status === 'confirmed').map(([id, e]) => ({ id, summary: e.body.summary, colorId: e.body.colorId ?? undefined, extendedProperties: e.body.extendedProperties }))
      return res(200, { items })
    }
    if (parts.length === 3 && m === 'POST') {
      if (c.events.has(body.id)) return res(409, { error: { code: 409, message: 'The requested identifier already exists.' } })
      c.events.set(body.id, { body, status: 'confirmed' })
      return res(200, { id: body.id })
    }
    const ev = c.events.get(parts[3])
    if (m === 'PUT') {
      // 本物と同じ: 送られた内容で丸ごと置き換え（送らなかった項目は消える）
      if (!ev) return res(404, {})
      c.events.set(parts[3], { body: { ...body }, status: body.status ?? 'confirmed' })
      return res(200, { id: parts[3] })
    }
    if (m === 'PATCH') {
      if (!ev) return res(404, {})
      // 本物の Google と同じ PATCH の動き: 入れ子のオブジェクト（start/end）は項目単位でマージ、null は削除
      const merged: Record<string, unknown> = { ...ev.body }
      for (const [k, v] of Object.entries(body)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object') {
          const o: Record<string, unknown> = { ...(merged[k] as object) }
          for (const [k2, v2] of Object.entries(v as object)) { if (v2 === null) delete o[k2]; else o[k2] = v2 }
          merged[k] = o
        } else if (v === null) delete merged[k]
        else merged[k] = v
      }
      c.events.set(parts[3], { body: merged, status: body.status ?? ev.status })
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
      completeTask: async (t) => {
        const cur = this.tasks.find((x) => x.id === t.id)!
        if (cur.assignment_mode === 'everyone') {
          cur.assignees = cur.assignees.map((a) => (a.user_id === uid ? { ...a, status: 'done', completed_at: 'x' } : a))
          if (cur.assignees.every((a) => a.status === 'done')) cur.status = 'done'
        } else if (cur.assignee_id === uid) cur.status = 'done'
        else throw new Error('RLS')
        return cur
      },
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
  assignment_mode: 'single', color_id: null, work_date: null, work_start: null, work_end: null, assignees: [], ...p,
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

  it('変更がなければ書き込みはせず、Google側の完了確認の読み取り1回だけ（無料枠の節約）', async () => {
    db.tasks.push(task({ assignee_id: YUSA }), task({ assignee_id: YUSA }))
    await sync(YUSA)
    const before = g.calls
    await sync(YUSA, { verifyCalendar: false })
    expect(g.calls - before).toBe(1)
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
    expect(g.live(EMAIL[YUSA])[0].summary).toBe('✔ 日報')
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

describe('色・書式の更新（実機で見つかった不具合）', () => {
  const ev = (taskId: string) => { for (const c of g.calendars.values()) { const e = c.events.get(eventIdFor(taskId)); if (e) return e.body } }
  it('色を「標準」に戻すと Google 側の色指定も消える（null を送らない）', async () => {
    const t = task({ title: '色', assignee_id: YUSA, color_id: '11' }); db.tasks.push(t)
    await sync(YUSA)
    expect(ev(t.id)!.colorId).toBe('11')
    t.color_id = null
    await sync(YUSA, { verifyCalendar: false })
    expect('colorId' in ev(t.id)!).toBe(false)
  })
  it('書式の変更（旧バージョンの「‼」付き予定など）は全予定を一度だけ送り直して上書きする', async () => {
    const t = task({ title: '褒章授与式', assignee_id: YUSA, priority: 'high' }); db.tasks.push(t)
    await sync(YUSA)
    editInGoogleRaw(t.id, { summary: '‼ 褒章授与式', colorId: '11' }) // 旧バージョンが書いた状態
    db.links = db.links.map((l) => ({ ...l, synced_hash: JSON.stringify([l.calendar_id, { summary: '‼ 褒章授与式' }]) })) // 旧形式の記録
    const r = await sync(YUSA, { verifyCalendar: false })
    expect(r.synced).toBe(1)
    expect(ev(t.id)!.summary).toBe('褒章授与式')
    expect('colorId' in ev(t.id)!).toBe(false)
    const r2 = await sync(YUSA, { verifyCalendar: false })
    expect(r2.synced).toBe(0) // 2回目以降は送らない
  })
  function editInGoogleRaw(taskId: string, patch: Record<string, unknown>) {
    for (const c of g.calendars.values()) { const e = c.events.get(eventIdFor(taskId)); if (e) Object.assign(e.body, patch) }
  }
})

describe('終日 ⇔ 時間指定の切り替え（実機で見つかった不具合）', () => {
  it('終日で登録後に作業時間を追加 → その時間帯の予定に変わる', async () => {
    const t = task({ title: 'テスト2', assignee_id: YUSA, due_date: '2026-11-07' }); db.tasks.push(t)
    await sync(YUSA)
    expect(g.shownAs(EMAIL[YUSA])).toEqual(['終日 2026-11-07'])
    Object.assign(t, { work_date: '2026-11-07', work_start: '17:00', work_end: '18:00' })
    await sync(YUSA)
    expect(g.shownAs(EMAIL[YUSA])).toEqual(['時間 2026-11-07T17:00:00'])
  })
  it('作業時間を消す → 終日に戻る', async () => {
    const t = task({ assignee_id: YUSA, due_date: '2026-11-07', work_date: '2026-11-07', work_start: '17:00', work_end: '18:00' }); db.tasks.push(t)
    await sync(YUSA)
    Object.assign(t, { work_date: null, work_start: null, work_end: null })
    await sync(YUSA)
    expect(g.shownAs(EMAIL[YUSA])).toEqual(['終日 2026-11-07'])
  })
})

describe('小項目（親の予定にまとめる）', () => {
  it('小項目は別の予定にならず、親の説明欄に ☑/☐ で表示。小項目の完了で親の予定が更新される', async () => {
    const p = task({ title: '広告動画', assignee_id: YUSA })
    const c1 = task({ title: '企画完了', parent_id: p.id, assignee_id: YUSA, created_at: '1' })
    const c2 = task({ title: '撮影完了', parent_id: p.id, assignee_id: YUSA, created_at: '2' })
    db.tasks.push(p, c1, c2)
    await sync(YUSA)
    expect(g.live(EMAIL[YUSA]).map((e) => e.summary)).toEqual(['広告動画'])
    const desc = () => String([...g.calendars.values()][0].events.get(eventIdFor(p.id))!.body.description)
    expect(desc()).toContain('小項目（0/2 完了）\n☐ 企画完了（11/6）\n☐ 撮影完了（11/6）')
    c1.status = 'done'
    const r = await sync(YUSA, { verifyCalendar: false })
    expect(r.synced).toBe(1)
    expect(desc()).toContain('小項目（1/2 完了）\n☑ 企画完了')
  })
  it('以前に別の予定として登録された小項目は自動で削除される', async () => {
    const p = task({ title: '親', assignee_id: YUSA }); const c = task({ title: '子', parent_id: p.id, assignee_id: YUSA })
    db.tasks.push(p, c)
    login(YUSA)
    await runSync({ uid: YUSA, storeId: 's1', api: googleCalendarApi, store: db.storeFor(YUSA), tasks: [p], today: TODAY, verifyCalendar: true })
    await googleCalendarApi.upsertEvent(db.accounts.get(YUSA)!.calendar_id!, eventIdFor(c.id), buildEvent(c, YUSA)) // 旧バージョンで作られた子の予定
    await db.storeFor(YUSA).saveLink({ task_id: c.id, user_id: YUSA, store_id: 's1', calendar_id: db.accounts.get(YUSA)!.calendar_id!, google_event_id: eventIdFor(c.id), sync_status: 'synced', synced_hash: 'old', last_error: null, retry_count: 0, synced_at: null })
    expect(g.live(EMAIL[YUSA])).toHaveLength(2)
    await sync(YUSA)
    expect(g.live(EMAIL[YUSA]).map((e) => e.summary)).toEqual(['親'])
  })
})

describe('Google側での完了操作 → アプリも完了', () => {
  /** Googleカレンダーアプリで人が予定を編集したことにする */
  const editInGoogle = (taskId: string, patch: Record<string, unknown>) => {
    for (const c of g.calendars.values()) { const e = c.events.get(eventIdFor(taskId)); if (e) Object.assign(e.body, patch) }
  }
  it('色をグレー（グラファイト）にする → アプリで完了、予定は「✔」表示に', async () => {
    const t = task({ title: 'テスト3', assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    editInGoogle(t.id, { colorId: '8' })
    const r = await sync(YUSA, { verifyCalendar: false })
    expect(r.completedFromGoogle).toBe(1)
    expect(t.status).toBe('done')
    expect(g.live(EMAIL[YUSA])[0].summary).toBe('✔ テスト3')
  })
  it('件名の先頭に「✅」や「完了」を付ける → アプリで完了', async () => {
    const a = task({ title: 'A', assignee_id: YUSA }), b = task({ title: 'B', assignee_id: YUSA }); db.tasks.push(a, b)
    await sync(YUSA)
    editInGoogle(a.id, { summary: '✅A' }); editInGoogle(b.id, { summary: '完了 B' })
    const r = await sync(YUSA, { verifyCalendar: false })
    expect(r.completedFromGoogle).toBe(2)
  })
  it('アプリで完了→元に戻した場合、Googleに残る古い ✅ で再び完了にしない', async () => {
    const t = task({ title: 'C', assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    t.status = 'done'; await sync(YUSA, { verifyCalendar: false }) // アプリが ✅ を書き込む
    t.status = 'open' // アプリで元に戻す（Googleにはまだ ✅ が残っている）
    const r = await sync(YUSA, { verifyCalendar: false })
    expect(r.completedFromGoogle).toBe(0)
    expect(t.status).toBe('open')
    expect(g.live(EMAIL[YUSA])[0].summary).toBe('C')
  })
  it('完了の目印がない編集（件名変更・色を赤など）では完了にしない', async () => {
    const t = task({ title: 'D', assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    editInGoogle(t.id, { summary: 'D（メモ）', colorId: '11' })
    const r = await sync(YUSA, { verifyCalendar: false })
    expect(r.completedFromGoogle).toBe(0)
    expect(t.status).toBe('open')
  })
  it('全員向けタスクは本人の分だけ完了になる', async () => {
    const t = task({ title: '日報', assignment_mode: 'everyone', assignees: [
      { user_id: YUSA, status: 'open', completed_at: null }, { user_id: SHOKO, status: 'open', completed_at: null }] })
    db.tasks.push(t)
    await sync(YUSA)
    editInGoogle(t.id, { colorId: '10' })
    await sync(YUSA, { verifyCalendar: false })
    expect(t.assignees.find((a) => a.user_id === YUSA)!.status).toBe('done')
    expect(t.assignees.find((a) => a.user_id === SHOKO)!.status).toBe('open')
    expect(t.status).toBe('open')
  })
  it('判定ロジック: 完了の目印', () => {
    expect(isDoneMarker({ summary: 'x', colorId: '10' })).toBe(true)
    expect(isDoneMarker({ summary: ' 完了 x', colorId: null })).toBe(true)
    expect(isDoneMarker({ summary: 'x 完了', colorId: null })).toBe(false)
  })
})

describe('全員向けタスク', () => {
  it('各自のカレンダーに入り、完了表示は本人の状態だけ', async () => {
    const t = task({ title: '日報提出', assignment_mode: 'everyone', assignees: [
      { user_id: YUSA, status: 'done', completed_at: 'x' }, { user_id: SHOKO, status: 'open', completed_at: null }] })
    db.tasks.push(t)
    await sync(YUSA); await sync(SHOKO)
    expect(g.live(EMAIL[YUSA])[0].summary).toBe('✔ 日報提出')
    expect(g.live(EMAIL[SHOKO])[0].summary).toBe('日報提出')
  })
  it('選んだメンバー（2人）だけのタスク: 2人のカレンダーに入り、外したメンバーからは消える', async () => {
    db.link(BOSS)
    const t = task({ title: '2人で準備', assignment_mode: 'group', assignees: [
      { user_id: YUSA, status: 'open', completed_at: null }, { user_id: SHOKO, status: 'open', completed_at: null }] })
    db.tasks.push(t)
    await sync(YUSA); await sync(SHOKO); await sync(BOSS)
    expect(g.live(EMAIL[YUSA]).map((e) => e.summary)).toEqual(['2人で準備'])
    expect(g.live(EMAIL[SHOKO]).map((e) => e.summary)).toEqual(['2人で準備'])
    expect(g.live(EMAIL[BOSS])).toHaveLength(0)
    t.assignees = [{ user_id: SHOKO, status: 'open', completed_at: null }, { user_id: BOSS, status: 'open', completed_at: null }]
    await sync(YUSA); await sync(BOSS)
    expect(g.live(EMAIL[YUSA])).toHaveLength(0)
    expect(g.live(EMAIL[BOSS]).map((e) => e.summary)).toEqual(['2人で準備'])
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
    expect(r.message).toContain('利用制限')
    g.failNext = null
    await sync(YUSA)
    expect(g.live(EMAIL[YUSA])[0].summary).toBe('変更')
  })

  it(`一時的な失敗は自動再試行、${MAX_AUTO_RETRY}回失敗後は手動（今すぐ同期）で再試行`, async () => {
    db.tasks.push(task({ assignee_id: YUSA }))
    await sync(YUSA) // カレンダー作成のみ成功させるため一旦同期
    db.tasks.push(task({ title: '失敗するタスク', assignee_id: YUSA }))
    // 1回目は完了確認の読み取り（失敗しても続行）、2回目が予定の書き込み
    for (let i = 0; i < MAX_AUTO_RETRY; i++) { g.failNext = { status: 500, count: 2 }; await sync(YUSA, { verifyCalendar: false }) }
    const before = g.calls
    await sync(YUSA, { verifyCalendar: false })
    expect(g.calls - before).toBe(1) // 読み取りのみ。失敗タスクの書き込みは自動では行わない
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
    expect(b.start).toMatchObject({ date: TODAY, dateTime: null }); expect(b.end).toMatchObject({ date: '2026-11-07' }); expect(b.transparency).toBe('transparent')
  })
  it('締切時刻 → 終日予定に「⏰18:00締切」（30分予定にしない）', () => {
    const b = buildEvent(task({ title: '月次報告', due_time: '18:00' }), YUSA)
    expect(b.summary).toBe('⏰18:00締切 月次報告'); expect(b.start.date).toBe(TODAY)
  })
  it('作業時間 → その時間帯に予定、締切は件名と説明に併記', () => {
    const b = buildEvent(task({ title: '撮影', due_date: '2026-11-10', due_time: '18:00', work_date: '2026-11-08', work_start: '10:00', work_end: '12:00' }), YUSA)
    expect(b.start).toEqual({ date: null, dateTime: '2026-11-08T10:00:00', timeZone: 'Asia/Tokyo' })
    expect(b.end.dateTime).toBe('2026-11-08T12:00:00')
    expect(b.summary).toBe('⏰11/10 18:00締切 撮影')
    expect(b.description).toContain('期限: 11/10 18:00')
  })
  it('優先度 高 → 件名・色とも変えない / 選んだ色 / 完了 → ✔ とグレー', () => {
    expect(buildEvent(task({ title: 'A', priority: 'high' }), YUSA)).toMatchObject({ summary: 'A', colorId: null })
    expect(buildEvent(task({ title: 'A', color_id: '7' }), YUSA)).toMatchObject({ summary: 'A', colorId: '7' })
    expect(buildEvent(task({ title: 'A', color_id: '7', status: 'done' }), YUSA)).toMatchObject({ summary: '✔ A', colorId: '8' })
  })
  it('アプリで色を選んだだけでは、Google側の完了操作と誤認しない', async () => {
    const t = task({ title: '色', assignee_id: YUSA }); db.tasks.push(t)
    await sync(YUSA)
    t.color_id = '11'
    await sync(YUSA, { verifyCalendar: false })
    const r = await sync(YUSA, { verifyCalendar: false })
    expect(r.completedFromGoogle).toBe(0)
    expect(g.live(EMAIL[YUSA])[0].summary).toBe('色')
  })
  it('予定IDは Google の形式（a-v, 0-9）', () => {
    expect(eventIdFor('0f8e2a4c-1b3d-4e5f-9a7b-c6d8e0f1a2b3')).toMatch(/^[a-v0-9]{5,1024}$/)
  })
})
