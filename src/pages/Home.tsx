import { useState } from 'react'
import { GoogleSyncBanner } from '../components/GoogleSyncPanel'
import { TaskItem } from '../components/TaskItem'
import { Empty, Stat, Tabs } from '../components/ui'
import { useApp } from '../lib/app'
import { todayStr } from '../lib/dates'
import { isAssignedTo, isUnassigned, showInMine } from '../lib/responsibility'
import { effectiveTasks, inBucket, sortTasks } from '../lib/selectors'

type View = 'today' | 'tomorrow' | 'week'

export function Home() {
  const { tasks, user, members } = useApp()
  const uid = user!.id
  const [view, setView] = useState<View>('today')
  const today = todayStr()
  const mine = effectiveTasks(tasks, uid).filter((t) => showInMine(t, uid))
  const overdue = mine.filter((t) => inBucket(t, 'overdue')).sort(sortTasks)
  const list = mine.filter((t) => inBucket(t, view)).sort(sortTasks)
  const doneToday = tasks.filter((t) => t.due_date === today && isAssignedTo(t, uid) && !mine.includes(t)).length
  const me = members.find((m) => m.user_id === uid)
  const hour = Number(new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Tokyo' }).format(new Date()))
  const greet = hour < 11 ? 'おはようございます' : hour < 18 ? 'お疲れさまです' : 'お疲れさまでした'

  return (
    <div className="space-y-5">
      <div>
        <div className="text-xs text-neutral-400">{new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Tokyo' }).format(new Date())}</div>
        <h1 className="mt-0.5 text-xl font-semibold">{greet}、{me?.profile.display_name ?? ''}さん</h1>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Stat label="期限超過" value={overdue.length} tone={overdue.length ? 'red' : undefined} />
        <Stat label="今日" value={mine.filter((t) => inBucket(t, 'today')).length} tone="orange" />
        <Stat label="明日" value={mine.filter((t) => inBucket(t, 'tomorrow')).length} />
        <Stat label="今日完了" value={doneToday} tone="green" />
      </div>

      <GoogleSyncBanner />

      {overdue.length > 0 && (
        <section>
          <h2 className="section-title text-red-600">⚠ 期限を過ぎています（{overdue.length}）</h2>
          <div className="space-y-2">{overdue.map((t) => <TaskItem key={t.id} task={t} showAssignee={isUnassigned(t)} />)}</div>
        </section>
      )}

      <section className="space-y-3">
        <Tabs value={view} onChange={setView} items={[
          { value: 'today', label: '今日', count: mine.filter((t) => inBucket(t, 'today')).length },
          { value: 'tomorrow', label: '明日', count: mine.filter((t) => inBucket(t, 'tomorrow')).length },
          { value: 'week', label: '今週', count: mine.filter((t) => inBucket(t, 'week')).length },
        ]} />
        <div className="space-y-2">
          {list.length ? list.map((t) => <TaskItem key={t.id} task={t} showAssignee={isUnassigned(t)} />)
            : <Empty>{view === 'today' ? '今日のタスクはすべて完了しています' : '該当するタスクはありません'}</Empty>}
        </div>
      </section>
    </div>
  )
}
