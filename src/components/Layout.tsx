import { useEffect, useState, type ReactNode } from 'react'
import { dueSummary } from '../lib/notify'
import { setBadge } from '../lib/pwa'
import { NavLink } from 'react-router-dom'
import { useApp } from '../lib/app'
import { todayStr } from '../lib/dates'
import { isAssignedTo, statusFor } from '../lib/responsibility'
import { TaskSheet } from './TaskSheet'

const NAV = [
  { to: '/', label: 'ホーム', icon: 'M3 10.5L12 3l9 7.5V21h-6v-6H9v6H3z' },
  { to: '/tasks', label: 'マイタスク', icon: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2' },
  { to: '/calendar', label: 'カレンダー', icon: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4' },
  { to: '/team', label: 'チーム', icon: 'M8 11a3 3 0 100-6 3 3 0 000 6zM16 11a3 3 0 100-6 3 3 0 000 6zM2 20c0-3 3-5 6-5s6 2 6 5M14 15c3 0 8 1 8 5' },
  { to: '/settings', label: '設定', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z' },
]

export function Layout({ children }: { children: ReactNode }) {
  const { store, tasks, user, toast, setToast } = useApp()
  const [adding, setAdding] = useState(false)
  const today = todayStr()
  // ホーム画面アイコンのバッジ: 期限超過・今日・明日の自分のタスク数（毎朝の通知と同じ数え方）
  useEffect(() => { if (user) setBadge(dueSummary(tasks, user.id, today).total) }, [tasks, user, today])
  const alerts = user ? tasks.filter((t) => isAssignedTo(t, user.id) && statusFor(t, user.id) === 'open' && t.due_date && t.due_date <= today).length : 0

  return (
    <div className="mx-auto min-h-dvh max-w-2xl pb-[calc(env(safe-area-inset-bottom)+160px)]">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-neutral-200/70 bg-white/95 px-4 backdrop-blur">
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-[0.18em]">NAORU<span className="text-gold"> TASK</span></span>
          <span className="truncate text-xs text-neutral-400">{store?.name}</span>
        </div>
        <NavLink to="/" className="relative flex h-10 w-10 items-center justify-center" aria-label="お知らせ">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0" /></svg>
          {alerts > 0 && <span className="absolute right-1 top-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">{alerts}</span>}
        </NavLink>
      </header>

      <main className="px-4 pt-4">{children}</main>

      <button onClick={() => setAdding(true)} aria-label="タスクを追加"
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+84px)] right-[max(1rem,calc(50%-20rem))] z-30 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-3xl font-light text-white shadow-lg shadow-black/20">+</button>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto grid max-w-2xl grid-cols-5">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}
              className={({ isActive }) => `flex h-16 flex-col items-center justify-center gap-1 text-[10px] ${isActive ? 'text-ink' : 'text-neutral-400'}`}>
              <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={n.icon} /></svg>
              {n.label}
            </NavLink>
          ))}
        </div>
      </nav>

      {adding && <TaskSheet onClose={() => setAdding(false)} />}
      {toast && (
        <div role="status" className={`fixed inset-x-4 top-16 z-[60] mx-auto flex max-w-md items-center gap-3 rounded-xl px-4 py-3 text-sm text-white shadow-lg ${toast.tone === 'error' ? 'bg-red-600' : toast.tone === 'success' ? 'bg-emerald-700' : 'bg-ink'}`}>
          <span className="flex-1" onClick={() => setToast(null)}>{toast.message}</span>
          {toast.action && <button className="-my-2 h-10 shrink-0 rounded-lg bg-white/15 px-3 text-sm font-semibold" onClick={toast.action.run}>{toast.action.label}</button>}
        </div>
      )}
    </div>
  )
}
