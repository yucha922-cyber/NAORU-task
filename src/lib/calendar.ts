/**
 * Google 認証（Google Identity Services）と Calendar API の実装。
 * - スコープ calendar.app.created: このアプリが作った「NAORU TASK」カレンダーだけを操作できる。
 *   利用者の既存カレンダー・既存予定は閲覧も編集もできない。
 * - openid email: 連携した Google アカウントを確認し、別アカウントへの誤同期を防ぐためだけに使用。
 * - アクセストークンはメモリ上のみ（localStorage・DB・GitHub に保存しない）。ページを閉じると消える。
 */
import { GoogleError } from './calendarSync'
import { createCalendarApi } from './calendarApi'

export const GOOGLE_CLIENT_ID = ((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '').trim()
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
const SCOPES = `${CALENDAR_SCOPE} openid email`

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string; scope?: string }
interface TokenClient { requestAccessToken(o?: { prompt?: string; login_hint?: string }): void }
interface CodeClient { requestCode(): void }
declare global {
  interface Window {
    google?: { accounts: { oauth2: {
      initTokenClient(c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }): TokenClient
      initCodeClient(c: { client_id: string; scope: string; ux_mode: 'popup'; select_account?: boolean; login_hint?: string; callback: (r: { code?: string; error?: string }) => void; error_callback?: (e: { type: string }) => void }): CodeClient
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

/**
 * 自動同期（サーバー側）用: Google から一度きりの認可コードを取得する（ボタン押下から呼ぶこと）。
 * コードはすぐにサーバー（Edge Function）へ渡し、サーバーが暗号化してトークンを保管する。ブラウザには残らない。
 */
export async function requestOfflineCode(expectedEmail?: string | null): Promise<string> {
  if (!GOOGLE_CLIENT_ID) throw new AuthFlowError('Google連携が未設定です。管理者に連絡してください。')
  await loadGis()
  return new Promise<string>((res, rej) => {
    const client = window.google!.accounts.oauth2.initCodeClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      ux_mode: 'popup',
      select_account: !expectedEmail,
      login_hint: expectedEmail ?? undefined,
      callback: (r) => (r.code ? res(r.code) : rej(new AuthFlowError(r.error === 'access_denied' ? 'Googleでの許可がキャンセルされました。連携するには「許可」を選んでください。' : 'Googleとの接続に失敗しました。もう一度お試しください。'))),
      error_callback: (e) => rej(new AuthFlowError(
        e.type === 'popup_closed' ? 'Googleの画面が閉じられました。もう一度ボタンを押してください。'
          : e.type === 'popup_failed_to_open' ? 'ポップアップがブロックされました。ブラウザでポップアップを許可してから、もう一度押してください。'
            : 'Googleとの接続を完了できませんでした。もう一度お試しください。')),
    })
    client.requestCode()
  })
}

export function revoke() {
  if (token) window.google?.accounts.oauth2.revoke(token.value)
  token = null
}

let requestDelay = 100

/** ブラウザ内のアクセストークンで Google Calendar を操作 */
export const googleCalendarApi = createCalendarApi(() => {
  if (!token || token.exp < Date.now()) throw new GoogleError('auth', 401, 'token expired')
  return token.value
}, { delayMs: () => requestDelay })

/** 単体テスト専用（本番コードからは使用しない） */
export const __test = {
  setToken(appUserId: string, email: string, value: string, ttlSec = 3600) { token = { value, appUserId, email, exp: Date.now() + ttlSec * 1000 } },
  setDelay(ms: number) { requestDelay = ms },
}
