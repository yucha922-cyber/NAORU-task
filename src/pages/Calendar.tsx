import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TaskItem } from '../components/TaskItem'
import { TaskSheet } from '../components/TaskSheet'
import { Empty } from '../components/ui'
import { useApp } from '../lib/app'
import { useCalendarSync } from '../lib/calendarManager'
import { showInMine, statusFor } from '../lib/responsibility'
import { addDays, dueState, fmt, todayStr } from '../lib/dates'
import { sortTasks } from '../lib/selectors'

export function CalendarPage() {
  const { tasks, user } = useApp()
  const today = todayStr()
  const [month, setMonth] = useState(today.slice(0, 7))
  const [sel, setSel] = useState(today)
  const [adding, setAdding] = useState(false)
  const [scope, setScope] = useState<'mine' | 'all'>('mine')

  const visible = tasks.filter((t) => !t.parent_id && t.due_date && (scope === 'all' || showInMine(t, user!.id)))
  const byDay = useMemo(() => {
    const m = new Map<string, typeof visible>()
    for (const t of visible) m.set(t.due_date!, [...(m.get(t.due_date!) ?? []), t])
    return m
  }, [visible])

  const first = `${month}-01`
  const startPad = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7 // 月曜始まり
  const days: (string | null)[] = Array(startPad).fill(null)
  for (let d = first; d.slice(0, 7) === month; d = addDays(d, 1)) days.push(d)
  const shift = (n: number) => { const [y, m] = month.split('-').map(Number); setMonth(fmt(new Date(Date.UTC(y, m - 1 + n, 1, 12))).slice(0, 7)) }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">カレンダー</h1>
        <div className="flex rounded-xl border border-neutral-200 bg-white p-0.5 text-xs">
          {(['mine', 'all'] as const).map((s) => (
            <button key={s} onClick={() => setScope(s)} className={`h-8 rounded-lg px-3 ${scope === s ? 'bg-ink text-white' : 'text-neutral-500'}`}>{s === 'mine' ? '自分' : '店舗全体'}</button>
          ))}
        </div>
      </div>

      <div className="card p-3">
        <div className="mb-2 flex items-center justify-between">
          <button className="h-10 w-10 text-neutral-500" onClick={() => shift(-1)} aria-label="前の月">‹</button>
          <div className="text-sm font-semibold">{Number(month.slice(0, 4))}年{Number(month.slice(5))}月</div>
          <button className="h-10 w-10 text-neutral-500" onClick={() => shift(1)} aria-label="次の月">›</button>
        </div>
        <div className="grid grid-cols-7 text-center text-[11px] text-neutral-400">
          {['月', '火', '水', '木', '金', '土', '日'].map((w) => <div key={w} className="py-1">{w}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {days.map((d, i) => {
            if (!d) return <div key={i} />
            const ts = byDay.get(d) ?? []
            const open = ts.filter((t) => statusFor(t, user!.id) === 'open')
            const st = (t: (typeof ts)[number]) => dueState({ status: 'open', due_date: t.due_date })
            const dot = open.some((t) => st(t) === 'overdue') ? 'bg-red-500' : open.some((t) => st(t) === 'soon') ? 'bg-orange-400' : open.length ? 'bg-ink' : ts.length ? 'bg-emerald-500' : ''
            return (
              <button key={d} onClick={() => setSel(d)}
                className={`flex h-12 flex-col items-center justify-center rounded-xl text-sm ${d === sel ? 'bg-ink text-white' : d === today ? 'bg-neutral-100 font-semibold' : ''}`}>
                {Number(d.slice(8))}
                <span className={`mt-1 h-1.5 w-1.5 rounded-full ${dot}`} />
              </button>
            )
          })}
        </div>
      </div>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="section-title">{Number(sel.slice(5, 7))}月{Number(sel.slice(8))}日のタスク</h2>
          <button className="mb-2 text-xs text-neutral-500" onClick={() => setAdding(true)}>＋ この日に追加</button>
        </div>
        <div className="space-y-2">
          {(byDay.get(sel) ?? []).sort(sortTasks).map((t) => <TaskItem key={t.id} task={t} showAssignee={scope === 'all'} />)}
          {!(byDay.get(sel) ?? []).length && <Empty>タスクはありません</Empty>}
        </div>
      </section>

      <GoogleStatus />
      {adding && <TaskSheet defaultDate={sel} onClose={() => setAdding(false)} />}
    </div>
  )
}

function GoogleStatus() {
  const g = useCalendarSync()
  if (!g.configured) return null
  return (
    <Link to="/settings" className="card flex items-center justify-between gap-3 p-4 text-sm">
      <div>
        <div className="font-medium">Googleカレンダー連携</div>
        <div className="text-xs text-neutral-500">
          {!g.linked ? '未連携 — 自分のタスクをGoogleカレンダーに表示できます' : g.running ? '同期中…' : g.pending ? `未反映 ${g.pending}件` : 'すべて反映済み'}
        </div>
      </div>
      <span className="text-neutral-300">›</span>
    </Link>
  )
}
