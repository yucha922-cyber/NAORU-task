/**
 * Google 認証（Google Identity Services）と Calendar API の実装。
 * - スコープ calendar.app.created: このアプリが作った「NAORU TASK」カレンダーだけを操作できる。
 *   利用者の既存カレンダー・既存予定は閲覧も編集もできない。
 * - openid email: 連携した Google アカウントを確認し、別アカウントへの誤同期を防ぐためだけに使用。
 * - アクセストークンはメモリ上のみ（localStorage・DB・GitHub に保存しない）。ページを閉じると消える。
 */
import { GoogleError, type CalendarApi, type EventBody, type RemoteEvent } from './calendarSync'

export const GOOGLE_CLIENT_ID = ((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '').trim()
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
const SCOPES = `${CALENDAR_SCOPE} openid email`
const API = 'https://www.googleapis.com/calendar/v3'

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string; scope?: string }
interface TokenClient { requestAccessToken(o?: { prompt?: string; login_hint?: string }): void }
declare global {
  interface Window {
    google?: { accounts: { oauth2: {
      initTokenClient(c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }): TokenClient
      hasGrantedAllScopes(r: TokenResponse, ...scopes: string[]): boolean
      revoke(token: string, cb?: () => void): void
    } } }
  }
}

let token: { value: string; exp: number; appUserId: string; email: string } | null = null

export const isConfigured = () => !!GOOGLE_CLIENT_ID
export function hasToken(appUserId: string) {
  return !!token && token.appUserId === appUserId && token.exp > Date.now() + 60_000
}
/** アプリのログインユーザーが変わったら必ず破棄（共有端末で他スタッフのトークンを使わない） */
export function clearToken() {
  token = null
}

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  return new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => res()
    s.onerror = () => rej(new AuthFlowError('Googleに接続できませんでした。通信状況を確認してもう一度お試しください。'))
    document.head.appendChild(s)
  })
}

export class AuthFlowError extends Error {}

/**
 * Google と接続（ボタン押下から呼ぶこと。ブラウザの仕様上、自動では呼べない）。
 * 2回目以降は同意画面は出ず、アカウント確認だけで完了することが多い。
 * expectedEmail を指定すると、別の Google アカウントが選ばれた場合は拒否する。
 */
export async function connect(appUserId: string, opts: { expectedEmail?: string | null; forceConsent?: boolean } = {}): Promise<string> {
  if (!GOOGLE_CLIENT_ID) throw new AuthFlowError('Google連携が未設定です。管理者に連絡してください。')
  await loadGis()
  const oauth = window.google!.accounts.oauth2
  const r = await new Promise<TokenResponse>((res, rej) => {
    const client = oauth.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: res,
      error_callback: (e) => rej(new AuthFlowError(
        e.type === 'popup_closed' ? 'Googleの画面が閉じられました。もう一度ボタンを押してください。'
          : e.type === 'popup_failed_to_open' ? 'ポップアップがブロックされました。ブラウザでポップアップを許可してから、もう一度押してください。'
            : 'Googleとの接続を完了できませんでした。もう一度お試しください。')),
    })
    client.requestAccessToken({ prompt: opts.forceConsent ? 'consent' : '', login_hint: opts.expectedEmail ?? undefined })
  })
  if (r.error || !r.access_token) {
    throw new AuthFlowError(r.error === 'access_denied' ? 'Googleでの許可がキャンセルされました。連携するには「許可」を選んでください。' : 'Googleとの接続に失敗しました。もう一度お試しください。')
  }
  if (!oauth.hasGrantedAllScopes(r, CALENDAR_SCOPE)) {
    oauth.revoke(r.access_token)
    throw new AuthFlowError('カレンダーへのアクセスが許可されませんでした。もう一度連携し、カレンダーのチェックをオンにしてください。')
  }
  const info = (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${r.access_token}` } })
    .then((x) => (x.ok ? x.json() : null)).catch(() => null)) as { email?: string } | null
  const email = info?.email?.toLowerCase() ?? ''
  if (!email) {
    oauth.revoke(r.access_token)
    throw new AuthFlowError('Googleアカウントを確認できませんでした。もう一度お試しください。')
  }
  if (opts.expectedEmail && email !== opts.expectedEmail.toLowerCase()) {
    oauth.revoke(r.access_token)
    throw new AuthFlowError(`別のGoogleアカウント（${email}）が選ばれました。連携済みのアカウント（${opts.expectedEmail}）を選んでください。`)
  }
  token = { value: r.access_token, exp: Date.now() + (r.expires_in ?? 3600) * 1000, appUserId, email }
  return email
}

export function revoke() {
  if (token) window.google?.accounts.oauth2.revoke(token.value)
  token = null
}

async function call(method: string, path: string, body?: unknown, calendarLevel = false) {
  if (!token || token.exp < Date.now()) throw new GoogleError('auth', 401, 'token expired')
  let r: Response
  try {
    r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
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

/** 新規作成時は null（項目の消去指示）を送らない */
function withoutNulls(b: EventBody) {
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null))
  return { ...clean(b as unknown as Record<string, unknown>), start: clean(b.start), end: clean(b.end) }
}

const cal = (id: string) => `/calendars/${encodeURIComponent(id)}`
let requestDelay = 100
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

/** 単体テスト専用（本番コードからは使用しない） */
export const __test = {
  setToken(appUserId: string, email: string, value: string, ttlSec = 3600) { token = { value, appUserId, email, exp: Date.now() + ttlSec * 1000 } },
  setDelay(ms: number) { requestDelay = ms },
}

export const googleCalendarApi: CalendarApi = {
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
    await sleep(requestDelay) // 1ユーザーあたりの毎分上限への配慮
    try {
      await call('PATCH', `${cal(calendarId)}/events/${eventId}`, body)
    } catch (e) {
      if (!(e instanceof GoogleError && e.kind === 'not_found')) throw e
      try {
        await call('POST', `${cal(calendarId)}/events`, { ...withoutNulls(body), id: eventId }, true)
      } catch (e2) {
        // 他の端末が同時に作成した → 内容を上書き
        if (e2 instanceof GoogleError && e2.kind === 'conflict') await call('PATCH', `${cal(calendarId)}/events/${eventId}`, body)
        else throw e2
      }
    }
  },
  async deleteEvent(calendarId, eventId) {
    await sleep(requestDelay)
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
