import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { repo } from './client'
import type { SessionUser } from './repo'
import type { Member, Role, Store, Task, TaskInput } from './types'
import { todayStr } from './dates'
import { isMulti, statusFor } from './responsibility'

const RECENT_DAYS = 31
const REFRESH_THROTTLE_MS = 60_000

export interface Toast {
  message: string
  tone?: 'info' | 'success' | 'error'
  action?: { label: string; run: () => void }
}

interface AppState {
  user: SessionUser | null
  loading: boolean
  stores: { store: Store; role: Role }[]
  store: Store | null
  role: Role | null
  isManager: boolean
  members: Member[]
  tasks: Task[]
  toast: Toast | null
  setToast(m: Toast | string | null): void
  selectStore(id: string): void
  reload(): Promise<void>
  memberName(id: string | null): string
  /** ワンタップ完了（全員向けタスクは自分の分）。完了時は「元に戻す」を表示 */
  toggleDone(t: Task): Promise<void>
  createTask(input: TaskInput): Promise<Task>
  updateTask(id: string, patch: Partial<TaskInput>): Promise<void>
  deleteTask(id: string): Promise<void>
  /** タスク変更・再取得後の追加処理（Googleカレンダー同期など）を登録 */
  onTasksChanged(fn: (tasks: Task[]) => void): () => void
}

const Ctx = createContext<AppState | null>(null)
// eslint-disable-next-line react-refresh/only-export-components
export const useApp = () => useContext(Ctx)!

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [stores, setStores] = useState<{ store: Store; role: Role }[]>([])
  const [storeId, setStoreId] = useState<string | null>(() => localStorage.getItem('naoru-store'))
  const [members, setMembers] = useState<Member[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [toast, setToastState] = useState<Toast | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const lastLoad = useRef(0)
  const genDay = useRef<string | null>(null)
  const listeners = useRef(new Set<(t: Task[]) => void>())

  const setToast = useCallback((m: Toast | string | null) => {
    const t = typeof m === 'string' ? { message: m, tone: 'error' as const } : m
    setToastState(t)
    clearTimeout(toastTimer.current)
    if (t) toastTimer.current = window.setTimeout(() => setToastState(null), t.action ? 6000 : t.tone === 'error' ? 8000 : 2500)
  }, [])

  const current = stores.find((s) => s.store.id === storeId) ?? stores[0] ?? null
  const store = current?.store ?? null
  const role = current?.role ?? null

  useEffect(() => {
    repo.getUser().then((u) => { setUser(u); if (!u) setLoading(false) })
    return repo.onAuthChange((u) => setUser((prev) => (prev?.id === u?.id ? prev : u)))
  }, [])

  useEffect(() => {
    if (!user) { setStores([]); setTasks([]); setMembers([]); return }
    setLoading(true)
    repo.myStores().then(setStores).catch((e) => setToast(e.message)).finally(() => setLoading(false))
  }, [user, setToast])

  const notify = (t: Task[]) => queueMicrotask(() => listeners.current.forEach((l) => l(t)))

  const load = useCallback(async (force = false) => {
    if (!store) return
    if (!force && Date.now() - lastLoad.current < REFRESH_THROTTLE_MS) return
    lastLoad.current = Date.now()
    try {
      // 繰り返しタスク生成は日付が変わった時だけ（API呼び出し削減）。冪等なので重複実行しても安全
      const today = todayStr(store.timezone)
      if (genDay.current !== `${store.id}:${today}`) {
        await repo.generateRecurring(store.id)
        genDay.current = `${store.id}:${today}`
      }
      const [m, t] = await Promise.all([repo.listMembers(store.id), repo.listTasks(store.id, RECENT_DAYS)])
      setMembers(m)
      setTasks(t)
      notify(t)
    } catch (e) {
      setToast((e as Error).message)
    }
  }, [store, setToast])

  useEffect(() => { lastLoad.current = 0; load(true) }, [load])
  // リアルタイム購読は使わず、画面復帰時に再取得（無料枠の接続数・通信量を節約）
  useEffect(() => {
    const h = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [load])

  const apply = useCallback((fn: (prev: Task[]) => Task[]) => {
    setTasks((prev) => {
      const next = fn(prev)
      notify(next)
      return next
    })
  }, [])

  // 安定した参照にする（再描画のたびに購読し直すと、同期のタイマーが毎回リセットされてしまう）
  const onTasksChanged = useCallback((fn: (t: Task[]) => void) => {
    listeners.current.add(fn)
    return () => { listeners.current.delete(fn) }
  }, [])

  const value = useMemo<AppState>(() => {
    const replace = (saved: Task) => apply((p) => p.map((x) => (x.id === saved.id ? saved : x)))

    async function setDone(t: Task, done: boolean) {
      const uid = user!.id
      const multi = isMulti(t)
      const mine = multi && t.assignees.some((a) => a.user_id === uid)
      if (multi && !mine) throw new Error('複数人のタスクは、担当の各自が自分の分を完了にします')
      // 楽観的更新でワンタップ即反映。失敗時は元に戻す
      const at = done ? new Date().toISOString() : null
      apply((p) => p.map((x) => x.id !== t.id ? x : mine
        ? { ...x, assignees: x.assignees.map((a) => (a.user_id === uid ? { ...a, status: done ? 'done' : 'open', completed_at: at } : a)) }
        : { ...x, status: done ? 'done' : 'open', completed_at: at }))
      try {
        replace(mine ? await repo.setMyDone(t.id, done) : await repo.setDone(t.id, done))
      } catch (e) {
        replace(t)
        throw e
      }
    }

    return {
      user, loading, stores, store, role, members, tasks, toast, setToast,
      isManager: role === 'manager' || role === 'admin',
      selectStore(id) { localStorage.setItem('naoru-store', id); setStoreId(id) },
      reload: () => load(true),
      memberName(id) {
        if (!id) return '未割当'
        return members.find((m) => m.user_id === id)?.profile.display_name || '不明'
      },
      async toggleDone(t) {
        const done = statusFor(t, user!.id) !== 'done'
        try {
          await setDone(t, done)
          if (done) {
            setToast({
              message: `「${t.title}」を完了にしました`, tone: 'success',
              action: { label: '元に戻す', run: () => { setToast(null); setDone({ ...t }, false).catch((e) => setToast((e as Error).message)) } },
            })
          }
        } catch (e) {
          setToast(`保存できませんでした：${(e as Error).message}`)
        }
      },
      async createTask(input) {
        if (!store) throw new Error('店舗が未選択です')
        const t = await repo.createTask(store.id, input)
        apply((p) => [...p, t])
        return t
      },
      async updateTask(id, patch) {
        replace(await repo.updateTask(id, patch))
      },
      async deleteTask(id) {
        // Googleカレンダーの予定は、担当者本人の次回同期で削除される（対応表に基づく）
        await repo.deleteTask(id)
        apply((p) => p.filter((x) => x.id !== id && x.parent_id !== id))
      },
      onTasksChanged,
    }
  }, [user, loading, stores, store, role, members, tasks, toast, load, apply, setToast, onTasksChanged])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
