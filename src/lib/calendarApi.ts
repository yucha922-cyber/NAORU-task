/**
 * Google Calendar API の呼び出し（ブラウザ・サーバー〔Supabase Edge Function / Deno〕共通）。
 * window や import.meta.env に依存しないこと。相対 import は Deno のため拡張子 .ts を付ける。
 */
import { GoogleError, type CalendarApi, type EventBody, type RemoteEvent } from './calendarSync.ts'

const API = 'https://www.googleapis.com/calendar/v3'
const cal = (id: string) => `/calendars/${encodeURIComponent(id)}`

/** 新規作成・置き換え時は null（項目の消去指示）を送らない */
function withoutNulls(b: EventBody) {
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null))
  return { ...clean(b as unknown as Record<string, unknown>), start: clean(b.start), end: clean(b.end) }
}

export function createCalendarApi(getToken: () => string | Promise<string>, opts: { delayMs?: () => number; fetchFn?: typeof fetch } = {}): CalendarApi {
  const doFetch = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())
  const delay = () => sleep(opts.delayMs ? opts.delayMs() : 100)

async function call(method: string, path: string, body?: unknown, calendarLevel = false) {
  const accessToken = await getToken()
  let r: Response
  try {
    r = await doFetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new GoogleError('network', 0, 'network error')
  }
  if (r.ok) return r.status === 204 ? null : r.json().catch(() => null)
  const text = await r.text().catch(() => '')
  if (r.status === 401) throw new GoogleError('auth', 401, text)
  if (r.status === 429 || (r.status === 403 && /rateLimit|quota|usageLimits/i.test(text))) throw new GoogleError('rate_limit', r.status, text)
  if (r.status === 403) throw new GoogleError('auth', 403, text) // 許可の取り消し等
  if (r.status === 404 || r.status === 410) throw new GoogleError(calendarLevel ? 'calendar_missing' : 'not_found', r.status, text)
  if (r.status === 409) throw new GoogleError('conflict', 409, text)
  throw new GoogleError('other', r.status, text.slice(0, 300))
}

return {
  async createCalendar() {
    const c = await call('POST', '/calendars', { summary: 'NAORU TASK', description: 'NAORU TASK が自動作成したカレンダーです（タスクの期限・作業予定）', timeZone: 'Asia/Tokyo' })
    return c.id as string
  },
  async calendarExists(id) {
    try { await call('GET', cal(id), undefined, true); return true } catch (e) {
      if (e instanceof GoogleError && (e.kind === 'calendar_missing' || e.kind === 'not_found')) return false
      throw e
    }
  },
  async upsertEvent(calendarId, eventId, body: EventBody) {
    await delay() // 1ユーザーあたりの毎分上限への配慮
    try {
      // 予定はアプリ専用カレンダーのものだけなので、毎回まるごと置き換える（PUT）。
      // 送らない項目（色・終日/時刻の不要な側）は自動で消えるため、null を送る必要がない
      await call('PUT', `${cal(calendarId)}/events/${eventId}`, { ...withoutNulls(body), id: eventId })
    } catch (e) {
      if (!(e instanceof GoogleError && e.kind === 'not_found')) throw e
      try {
        await call('POST', `${cal(calendarId)}/events`, { ...withoutNulls(body), id: eventId }, true)
      } catch (e2) {
        // 他の端末が同時に作成した → 内容を上書き
        if (e2 instanceof GoogleError && e2.kind === 'conflict') await call('PUT', `${cal(calendarId)}/events/${eventId}`, { ...withoutNulls(body), id: eventId })
        else throw e2
      }
    }
  },
  async deleteEvent(calendarId, eventId) {
    await delay()
    try { await call('DELETE', `${cal(calendarId)}/events/${eventId}`) } catch (e) {
      if (e instanceof GoogleError && (e.kind === 'not_found' || e.kind === 'calendar_missing')) return
      throw e
    }
  },
  async listChangedEvents(calendarId, updatedMin, timeMin) {
    const out: RemoteEvent[] = []
    let pageToken = ''
    let since = updatedMin
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ maxResults: '250', showDeleted: 'false', timeMin, fields: 'items(id,summary,colorId,extendedProperties),nextPageToken' })
      if (since) q.set('updatedMin', since)
      if (pageToken) q.set('pageToken', pageToken)
      let r: { items?: { id: string; summary?: string; colorId?: string; extendedProperties?: { private?: { naoruTaskId?: string } } }[]; nextPageToken?: string }
      try {
        r = await call('GET', `${cal(calendarId)}/events?${q}`, undefined, true)
      } catch (e) {
        // updatedMin が古すぎる場合（410）は条件なしで取り直す
        if (e instanceof GoogleError && e.status === 410 && since) { since = null; page--; continue }
        throw e
      }
      for (const it of r.items ?? []) out.push({ id: it.id, summary: it.summary ?? '', colorId: it.colorId ?? null, taskId: it.extendedProperties?.private?.naoruTaskId ?? null })
      if (!r.nextPageToken) break
      pageToken = r.nextPageToken
    }
    return out
  },
  async deleteCalendar(id) {
    try { await call('DELETE', cal(id), undefined, true) } catch (e) {
      if (e instanceof GoogleError && (e.kind === 'calendar_missing' || e.kind === 'not_found')) return
      throw e
    }
  },
}
}
