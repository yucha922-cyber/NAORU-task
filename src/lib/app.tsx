import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { repo } from './client'
import type { SessionUser } from './repo'
import type { Member, Role, Store, Task, TaskInput } from './types'
import { todayStr } from './dates'
import * as gcal from './calendar'

const RECENT_DAYS = 31
const REFRESH_THROTTLE_MS = 60_000

interface AppState {
  user: SessionUser | null
  loading: boolean
  stores: { store: Store; role: Role }[]
  store: Store | null
  role: Role | null
  isManager: boolean
  members: Member[]
  tasks: Task[]
  toast: string | null
  setToast(m: string | null): void
  selectStore(id: string): void
  reload(): Promise<void>
  memberName(id: string | null): string
  toggleDone(t: Task): Promise<void>
  createTask(input: TaskInput): Promise<Task>
  updateTask(id: string, patch: Partial<TaskInput>): Promise<void>
  deleteTask(id: string): Promise<void>
  /** タスク変更後の追加処理（Googleカレンダー同期など）を登録 */
  onTasksChanged(fn: (tasks: Task[]) => void): () => void
}

const Ctx = createContext<AppState | null>(null)
export const useApp = () => useContext(Ctx)!

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [stores, setStores] = useState<{ store: Store; role: Role }[]>([])
  const [storeId, setStoreId] = useState<string | null>(() => localStorage.getItem('naoru-store'))
  const [members, setMembers] = useState<Member[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const lastLoad = useRef(0)
  const genDay = useRef<string | null>(null)
  const listeners = useRef(new Set<(t: Task[]) => void>())

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
  }, [user])

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
      listeners.current.forEach((l) => l(t))
    } catch (e) {
      setToast((e as Error).message)
    }
  }, [store])

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
      queueMicrotask(() => listeners.current.forEach((l) => l(next)))
      return next
    })
  }, [])

  const value = useMemo<AppState>(() => ({
    user, loading, stores, store, role, members, tasks, toast, setToast,
    isManager: role === 'manager' || role === 'admin',
    selectStore(id) { localStorage.setItem('naoru-store', id); setStoreId(id) },
    reload: () => load(true),
    memberName(id) {
      if (!id) return '未割当'
      return members.find((m) => m.user_id === id)?.profile.display_name || '不明'
    },
    async toggleDone(t) {
      const done = t.status !== 'done'
      // 楽観的更新でワンタップ即反映。失敗時は元に戻す
      apply((p) => p.map((x) => (x.id === t.id ? { ...x, status: done ? 'done' : 'open', completed_at: done ? new Date().toISOString() : null } : x)))
      try {
        const saved = await repo.setDone(t.id, done)
        apply((p) => p.map((x) => (x.id === t.id ? saved : x)))
      } catch (e) {
        apply((p) => p.map((x) => (x.id === t.id ? t : x)))
        setToast((e as Error).message)
      }
    },
    async createTask(input) {
      if (!store) throw new Error('店舗が未選択です')
      const t = await repo.createTask(store.id, input)
      apply((p) => [...p, t])
      return t
    },
    async updateTask(id, patch) {
      const t = await repo.updateTask(id, patch)
      apply((p) => p.map((x) => (x.id === id ? t : x)))
    },
    async deleteTask(id) {
      await repo.deleteTask(id)
      // Google連携中なら、このアプリが作成した対応予定も削除（失敗しても削除自体は完了扱い）
      if (store && gcal.hasToken()) {
        repo.listCalendarLinks(store.id)
          .then((ls) => Promise.all(ls.filter((l) => l.task_id === id || tasks.some((t) => t.id === l.task_id && t.parent_id === id)).map(gcal.deleteEvent)))
          .catch((e) => setToast(`カレンダー予定の削除に失敗: ${(e as Error).message}`))
      }
      apply((p) => p.filter((x) => x.id !== id && x.parent_id !== id))
    },
    onTasksChanged(fn) { listeners.current.add(fn); return () => { listeners.current.delete(fn) } },
  }), [user, loading, stores, store, role, members, tasks, toast, load, apply])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
