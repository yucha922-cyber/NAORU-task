import { useEffect, useState } from 'react'
import { TaskItem } from '../components/TaskItem'
import { Empty, Tabs } from '../components/ui'
import { StaffFilter } from '../components/StaffFilter'
import { useApp } from '../lib/app'
import { repo } from '../lib/client'
import { effectiveTasks, inBucket, sortTasks, type Bucket } from '../lib/selectors'
import type { Task } from '../lib/types'
import { isAssignedTo, isStoreWide, isUnassigned, showInMine } from '../lib/responsibility'

type View = Bucket | 'history'
/** 自分: 自分の担当＋店舗全体 / 店舗全体: 全員・未割当のタスクだけ / 全スタッフ: すべて（院長・管理者のみ） */
type Scope = 'mine' | 'store' | 'everyone'
const SCOPE_LABEL: Record<Scope, string> = { mine: '自分', store: '店舗全体', everyone: '全スタッフ' }

function inScope(t: Task, scope: Scope, uid: string) {
  if (scope === 'everyone') return true
  if (scope === 'store') return isStoreWide(t)
  return showInMine(t, uid)
}

export function MyTasks() {
  const app = useApp()
  const [view, setView] = useState<View>('today')
  const [scope, setScope] = useState<Scope>('mine')
  const [staff, setStaff] = useState('')
  const uid = app.user!.id
  const scopes: Scope[] = app.isManager ? ['mine', 'store', 'everyone'] : ['mine', 'store']
  // 全スタッフ表示では、選んだスタッフの担当（本人の完了状態）で絞り込む
  const base = (scope === 'everyone' && staff
    ? effectiveTasks(app.tasks, staff).filter((t) => isAssignedTo(t, staff))
    : effectiveTasks(app.tasks, uid).filter((t) => inScope(t, scope, uid)))
  const count = (b: Bucket) => base.filter((t) => inBucket(t, b)).length
  const list = view === 'history' ? [] : base.filter((t) => inBucket(t, view)).sort(sortTasks)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">マイタスク</h1>
        <div className="flex rounded-xl border border-neutral-200 bg-white p-0.5 text-xs">
          {scopes.map((s) => (
            <button key={s} onClick={() => setScope(s)} className={`h-8 rounded-lg px-2.5 ${scope === s ? 'bg-ink text-white' : 'text-neutral-500'}`}>{SCOPE_LABEL[s]}</button>
          ))}
        </div>
      </div>
      {scope === 'everyone' && <StaffFilter members={app.members} value={staff} onChange={setStaff} />}
      <Tabs value={view} onChange={setView} items={[
        { value: 'overdue', label: '期限超過', count: count('overdue') },
        { value: 'today', label: '今日', count: count('today') },
        { value: 'tomorrow', label: '明日', count: count('tomorrow') },
        { value: 'week', label: '今週', count: count('week') },
        { value: 'all', label: 'すべて', count: count('all') },
        { value: 'history', label: '完了履歴' },
      ]} />
      {view === 'history' ? <History scope={scope} staff={scope === 'everyone' ? staff : ''} /> : (
        <div className="space-y-2">
          {list.length ? list.map((t) => <TaskItem key={t.id} task={t} showAssignee={scope !== 'mine' || isUnassigned(t)} />) : <Empty>該当するタスクはありません</Empty>}
        </div>
      )}
    </div>
  )
}

const PAGE = 30

function History({ scope, staff }: { scope: Scope; staff: string }) {
  const app = useApp()
  const [rows, setRows] = useState<Task[]>([])
  const [more, setMore] = useState(true)
  const load = async (offset: number) => {
    const r = await repo.listHistory(app.store!.id, offset, PAGE)
    setRows((p) => (offset ? [...p, ...r] : r))
    setMore(r.length === PAGE)
  }
  // ページ単位で取得（全件取得しない）
  useEffect(() => { load(0).catch((e) => app.setToast(e.message)) }, [app.store?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = rows.filter((t) => scope === 'everyone' ? (!staff || isAssignedTo(t, staff) || t.completed_by === staff) : scope === 'store' ? isStoreWide(t) : isAssignedTo(t, app.user!.id) || t.completed_by === app.user!.id)
  return (
    <div className="space-y-2">
      {shown.map((t) => (
        <div key={t.id} className="card flex items-center gap-3 border-l-4 border-l-emerald-500 px-4 py-3">
          <button className="text-emerald-600" onClick={async () => { await app.toggleDone(t); setRows((p) => p.filter((x) => x.id !== t.id)) }} title="未完了に戻す">✓</button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-neutral-600">{t.parent_id && <span className="text-neutral-400">└ </span>}{t.title}</div>
            <div className="text-[11px] text-neutral-400">
              {app.memberName(t.completed_by)} が {new Date(t.completed_at!).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} に完了
            </div>
          </div>
        </div>
      ))}
      {!shown.length && <Empty>完了したタスクはまだありません</Empty>}
      {more && <button className="btn-ghost w-full" onClick={() => load(rows.length)}>さらに読み込む</button>}
    </div>
  )
}
