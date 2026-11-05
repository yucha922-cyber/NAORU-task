import { Link } from 'react-router-dom'
import { TaskItem } from '../components/TaskItem'
import { Empty, Stat } from '../components/ui'
import { useApp } from '../lib/app'
import { addDays, todayStr } from '../lib/dates'
import { effectiveTasks, inBucket, sortTasks } from '../lib/selectors'

export function Home() {
  const { tasks, user, members } = useApp()
  const today = todayStr()
  const mine = effectiveTasks(tasks).filter((t) => t.assignee_id === user!.id || t.assignee_id === null)
  const overdue = mine.filter((t) => inBucket(t, 'overdue')).sort(sortTasks)
  const todays = mine.filter((t) => inBucket(t, 'today')).sort(sortTasks)
  const doneToday = tasks.filter((t) => t.status === 'done' && t.assignee_id === user!.id && t.due_date === today).length
  const me = members.find((m) => m.user_id === user!.id)
  const hour = Number(new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Tokyo' }).format(new Date()))
  const greet = hour < 11 ? 'おはようございます' : hour < 18 ? 'お疲れさまです' : 'お疲れさまでした'

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-neutral-400">{new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Tokyo' }).format(new Date())}</div>
        <h1 className="mt-0.5 text-xl font-semibold">{greet}、{me?.profile.display_name ?? ''}さん</h1>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Stat label="期限超過" value={overdue.length} tone={overdue.length ? 'red' : undefined} />
        <Stat label="今日" value={todays.length} tone={todays.length ? 'orange' : undefined} />
        <Stat label="明日" value={mine.filter((t) => inBucket(t, 'tomorrow')).length} />
        <Stat label="今日完了" value={doneToday} tone="green" />
      </div>

      {overdue.length > 0 && (
        <section>
          <h2 className="section-title text-red-600">⚠ 期限を過ぎています</h2>
          <div className="space-y-2">{overdue.map((t) => <TaskItem key={t.id} task={t} showAssignee={false} />)}</div>
        </section>
      )}

      <section>
        <h2 className="section-title">今日のタスク</h2>
        <div className="space-y-2">
          {todays.length ? todays.map((t) => <TaskItem key={t.id} task={t} showAssignee={t.assignee_id === null} />) : <Empty>今日のタスクはすべて完了しています</Empty>}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="section-title">明日以降（7日間）</h2>
          <Link to="/tasks" className="mb-2 text-xs text-neutral-500">すべて見る →</Link>
        </div>
        <div className="space-y-2">
          {mine.filter((t) => t.due_date && t.due_date > today && t.due_date <= addDays(today, 7)).sort(sortTasks).slice(0, 5)
            .map((t) => <TaskItem key={t.id} task={t} showAssignee={false} compact />)}
        </div>
      </section>
    </div>
  )
}
