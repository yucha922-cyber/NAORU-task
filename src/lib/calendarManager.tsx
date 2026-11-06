/**
 * Googleカレンダー同期の管理（アプリ全体で1つ）。
 * - 起動時・タスク変更時・画面復帰時に「未反映」を検出（Googleへの接続なしで数えられる）
 * - Googleと接続中（約1時間）は自動で反映。接続が切れていればホームに「反映する」ボタンを出す
 *   （ブラウザの仕様で、Googleへの接続はボタン操作からしか開始できない）
 * - 他の人がタスクを変更・削除・担当変更しても、本人が次にアプリを開いて反映した時に Google 側へ反映される
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useApp } from './app'
import * as gcal from './calendar'
import { countPending, friendlyError, runSync, type SyncResult, type SyncStore } from './calendarSync'
import { repo } from './client'
import { todayStr } from './dates'
import type { CalendarLink, GoogleAccount } from './types'

const syncStore: SyncStore = {
  getAccount: () => repo.getGoogleAccount(),
  claimCalendar: (id) => repo.claimCalendar(id),
  resetCalendar: () => repo.saveGoogleAccount({ calendar_id: null }),
  updateAccount: (p) => repo.saveGoogleAccount(p),
  listLinks: () => repo.listMyCalendarLinks(),
  saveLink: (l) => repo.saveCalendarLink(l),
  deleteLink: (id) => repo.deleteCalendarLink(id),
  fetchTasks: (ids) => repo.getTasksByIds(ids),
}

interface CalendarSyncState {
  configured: boolean
  account: GoogleAccount | null
  linked: boolean
  connected: boolean
  running: boolean
  pending: number
  failedLinks: CalendarLink[]
  /** Googleカレンダーに反映済みの予定の件数（累計の現在値） */
  syncedCount: number
  lastResult: SyncResult | null
  error: string | null
  connect(opts?: { forceConsent?: boolean }): Promise<void>
  syncNow(): Promise<void>
  disconnect(): Promise<void>
}

const Ctx = createContext<CalendarSyncState | null>(null)
// eslint-disable-next-line react-refresh/only-export-components
export const useCalendarSync = () => useContext(Ctx)!

export function CalendarSyncProvider({ children }: { children: ReactNode }) {
  const app = useApp()
  const uid = app.user?.id ?? null
  const [account, setAccount] = useState<GoogleAccount | null>(null)
  const [links, setLinks] = useState<CalendarLink[]>([])
  const [connected, setConnected] = useState(false)
  const [running, setRunning] = useState(false)
  const [lastResult, setLastResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const rerun = useRef(false)
  const verified = useRef(false)
  const tasksRef = useRef(app.tasks)
  tasksRef.current = app.tasks

  const refresh = useCallback(async () => {
    if (!uid) return
    try {
      const [a, l] = await Promise.all([repo.getGoogleAccount(), repo.listMyCalendarLinks()])
      setAccount(a)
      setLinks(l)
    } catch { /* 未マイグレーション等。タスク管理には影響させない */ }
  }, [uid])

  // ログインユーザーが変わったら、前のユーザーの Google 接続を必ず破棄
  useEffect(() => {
    gcal.clearToken()
    setConnected(false)
    verified.current = false
    setAccount(null)
    setLinks([])
    refresh()
  }, [uid, refresh])

  const sync = useCallback(async (force = false) => {
    if (!uid || !app.store) return
    if (!gcal.hasToken(uid)) { setConnected(false); return }
    if (busy.current) { rerun.current = true; return }
    busy.current = true
    setRunning(true)
    try {
      const r = await runSync({
        uid, storeId: app.store.id, api: gcal.googleCalendarApi, store: syncStore,
        tasks: tasksRef.current, today: todayStr(app.store.timezone), verifyCalendar: !verified.current, force,
      })
      verified.current = true
      setLastResult(r)
      setError(r.stopped ? r.message : null)
      if (r.stopped === 'auth') { gcal.clearToken(); setConnected(false) }
    } catch (e) {
      setError(friendlyError(e)) // DB 側のエラー等。タスク管理は継続
    } finally {
      busy.current = false
      setRunning(false)
      await refresh()
      if (rerun.current) { rerun.current = false; void sync() }
    }
  }, [uid, app.store, refresh])

  // タスクの追加・編集・完了・再取得のたびに（接続中なら）自動反映。3秒まとめて送信
  const syncRef = useRef(sync)
  syncRef.current = sync
  const { onTasksChanged } = app
  useEffect(() => {
    let timer: number | undefined
    const off = onTasksChanged(() => {
      clearTimeout(timer)
      timer = window.setTimeout(() => { if (uid && gcal.hasToken(uid)) void syncRef.current() }, 3000)
    })
    return () => { off(); clearTimeout(timer) }
  }, [onTasksChanged, uid])

  // 画面復帰時: 対応表を取り直し（他端末・他スタッフの変更を検出）、接続中なら反映
  useEffect(() => {
    const h = () => {
      if (document.visibilityState !== 'visible' || !uid) return
      const ok = gcal.hasToken(uid)
      setConnected(ok)
      if (ok) void sync(); else void refresh()
    }
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [uid, sync, refresh])

  const linked = !!account && account.status !== 'disconnected'
  const pending = useMemo(() => {
    if (!uid || !linked || !app.store) return 0
    return countPending(uid, account!.calendar_id, app.tasks, links, todayStr(app.store.timezone))
  }, [uid, linked, account, app.tasks, app.store, links])

  const value: CalendarSyncState = {
    configured: gcal.isConfigured(),
    account, linked, connected, running, pending, lastResult, error,
    failedLinks: links.filter((l) => l.sync_status === 'error' || l.sync_status === 'reauth_required'),
    syncedCount: links.filter((l) => l.sync_status === 'synced').length,
    async connect(opts) {
      if (!uid) return
      setError(null)
      try {
        const email = await gcal.connect(uid, { expectedEmail: linked ? account!.google_email : null, forceConsent: opts?.forceConsent || !linked })
        if (!linked) await repo.saveGoogleAccount({ google_email: email, status: 'active', calendar_id: account?.calendar_id ?? null, last_error: null })
        else if (account!.status !== 'active') await repo.saveGoogleAccount({ status: 'active', last_error: null })
        setConnected(true)
        await refresh()
        await sync(true)
      } catch (e) {
        setError(friendlyError(e))
      }
    },
    async syncNow() {
      if (!uid) return
      if (!gcal.hasToken(uid)) return value.connect()
      await sync(true)
    },
    async disconnect() {
      if (!uid) return
      setError(null)
      try {
        if (!gcal.hasToken(uid)) await gcal.connect(uid, { expectedEmail: account?.google_email })
        if (account?.calendar_id) await gcal.googleCalendarApi.deleteCalendar(account.calendar_id)
      } catch (e) {
        if (!confirm(`Google側の「NAORU TASK」カレンダーを削除できませんでした（${friendlyError(e)}）。\nアプリ側の連携情報だけ解除しますか？（Googleカレンダー上のカレンダーは手動で削除できます）`)) return
      }
      await repo.deleteAllMyCalendarLinks()
      await repo.deleteGoogleAccount()
      gcal.revoke()
      setConnected(false)
      verified.current = false
      setLastResult(null)
      await refresh()
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
