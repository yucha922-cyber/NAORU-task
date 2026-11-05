/**
 * Googleカレンダー一方向同期（アプリ → Google）。
 * - スコープ calendar.app.created: このアプリが作成した「NAORU TASK」カレンダーのみ操作可能。
 *   利用者の既存カレンダー・既存予定は読み取りも編集もできない（無断編集を構造的に防止）。
 * - ブラウザ内で Google Identity Services のトークンを取得。サーバー・秘密鍵不要、課金設定不要。
 * - 内容が変わったタスクだけ送信（ハッシュ比較）して API 呼び出しを最小化。
 * - 失敗は task_calendar_links に記録し、次回同期時に自動再試行（最大5回、以降は手動）。
 */
import { addDays } from './dates'
import type { CalendarLink, Task } from './types'

export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? ''
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
const API = 'https://www.googleapis.com/calendar/v3'
const MAX_AUTO_RETRY = 5

interface TokenClient { requestAccessToken(o?: { prompt?: string }): void }
declare global {
  interface Window {
    google?: { accounts: { oauth2: {
      initTokenClient(c: { client_id: string; scope: string; callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void }): TokenClient
      revoke(token: string, cb?: () => void): void
    } } }
  }
}

let token: { value: string; exp: number } | null = null

export const isConfigured = () => !!GOOGLE_CLIENT_ID
export const hasToken = () => !!token && token.exp > Date.now() + 60_000
const calKey = (userId: string) => `naoru-gcal-calendar:${userId}`
export const isLinked = (userId: string) => !!localStorage.getItem(calKey(userId))

function loadGis(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve()
  return new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => res()
    s.onerror = () => rej(new Error('Googleの認証スクリプトを読み込めませんでした'))
    document.head.appendChild(s)
  })
}

/** ユーザー操作（ボタン押下）から呼ぶこと。ポップアップで同意画面が出る */
export async function connect(interactive = true): Promise<void> {
  if (!GOOGLE_CLIENT_ID) throw new Error('VITE_GOOGLE_CLIENT_ID が未設定です')
  await loadGis()
  await new Promise<void>((res, rej) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) return rej(new Error(r.error ?? 'Google連携に失敗しました'))
        token = { value: r.access_token, exp: Date.now() + (r.expires_in ?? 3600) * 1000 }
        res()
      },
    })
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
  })
}

export function disconnect(userId: string) {
  if (token) window.google?.accounts.oauth2.revoke(token.value)
  token = null
  localStorage.removeItem(calKey(userId))
}

class HttpError extends Error {
  status: number
  constructor(status: number, msg: string) { super(msg); this.status = status }
}

async function call(method: string, path: string, body?: unknown) {
  if (!hasToken()) throw new HttpError(401, 'Googleの認証期限が切れました。再連携してください')
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token!.value}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new HttpError(r.status, `Google API ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.status === 204 ? null : r.json()
}

async function ensureCalendar(userId: string): Promise<string> {
  const cached = localStorage.getItem(calKey(userId))
  if (cached) return cached
  const cal = await call('POST', '/calendars', { summary: 'NAORU TASK', description: 'NAORU TASK が自動作成したカレンダー', timeZone: 'Asia/Tokyo' })
  localStorage.setItem(calKey(userId), cal.id)
  return cal.id
}

function eventBody(t: Task) {
  const done = t.status === 'done'
  const base = {
    summary: `${done ? '✅ ' : ''}${t.title}`,
    description: 'NAORU TASK で管理しているタスクです（アプリ側で編集してください）',
    colorId: done ? '10' : t.priority === 'high' ? '11' : undefined,
    transparency: 'transparent',
  }
  if (t.due_time) {
    const start = `${t.due_date}T${t.due_time}:00+09:00`
    const end = new Date(new Date(start).getTime() + 30 * 60_000).toISOString()
    return { ...base, start: { dateTime: start, timeZone: 'Asia/Tokyo' }, end: { dateTime: end, timeZone: 'Asia/Tokyo' } }
  }
  return { ...base, start: { date: t.due_date }, end: { date: addDays(t.due_date!, 1) } }
}

const hashOf = (t: Task) => JSON.stringify([t.title, t.due_date, t.due_time, t.status, t.priority])

export interface SyncResult { synced: number; skipped: number; failed: number; stoppedByLimit: boolean }

/** 自分が担当で期限ありのタスクを同期 */
export async function syncTasks(opts: {
  userId: string
  storeId: string
  tasks: Task[]
  links: CalendarLink[]
  save: (l: CalendarLink) => Promise<void>
  forceRetry?: boolean
}): Promise<SyncResult> {
  const res: SyncResult = { synced: 0, skipped: 0, failed: 0, stoppedByLimit: false }
  const calendarId = await ensureCalendar(opts.userId)
  const linkMap = new Map(opts.links.map((l) => [l.task_id, l]))
  const targets = opts.tasks.filter((t) => t.assignee_id === opts.userId && t.due_date && !t.deleted_at)

  for (const t of targets) {
    const link = linkMap.get(t.id)
    const h = hashOf(t)
    if (link && link.calendar_id === calendarId && link.sync_status === 'synced' && link.synced_hash === h) { res.skipped++; continue }
    if (link?.sync_status === 'error' && link.retry_count >= MAX_AUTO_RETRY && !opts.forceRetry) { res.skipped++; continue }
    const next: CalendarLink = link && link.calendar_id === calendarId
      ? { ...link }
      : { task_id: t.id, user_id: opts.userId, store_id: opts.storeId, calendar_id: calendarId, google_event_id: null, sync_status: 'pending', synced_hash: null, last_error: null, retry_count: 0, synced_at: null }
    try {
      let ev
      if (next.google_event_id) {
        try {
          ev = await call('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${next.google_event_id}`, eventBody(t))
        } catch (e) {
          if (e instanceof HttpError && (e.status === 404 || e.status === 410)) ev = null
          else throw e
        }
      }
      if (!ev) ev = await call('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, eventBody(t))
      Object.assign(next, { google_event_id: ev.id, sync_status: 'synced', synced_hash: h, last_error: null, retry_count: 0, synced_at: new Date().toISOString() })
      res.synced++
    } catch (e) {
      Object.assign(next, { sync_status: 'error', last_error: String((e as Error).message).slice(0, 300), retry_count: next.retry_count + 1 })
      res.failed++
      if (e instanceof HttpError && e.status === 404 && /calendar/i.test(e.message)) localStorage.removeItem(calKey(opts.userId))
      if (e instanceof HttpError && (e.status === 429 || e.status === 403 || e.status === 401)) {
        await opts.save(next)
        res.stoppedByLimit = true // 上限・認証エラー時はその回の同期を中断（無駄な呼び出しをしない）
        break
      }
    }
    await opts.save(next)
    await new Promise((r) => setTimeout(r, 120)) // レート制限対策
  }
  return res
}

/** タスク削除時、対応する予定を削除（アプリが作成した予定のみ） */
export async function deleteEvent(link: CalendarLink) {
  if (!link.google_event_id || !hasToken()) return
  try {
    await call('DELETE', `/calendars/${encodeURIComponent(link.calendar_id)}/events/${link.google_event_id}`)
  } catch (e) {
    if (!(e instanceof HttpError && (e.status === 404 || e.status === 410))) throw e
  }
}
