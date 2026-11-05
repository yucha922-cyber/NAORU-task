import { useState } from 'react'
import { useApp } from '../lib/app'
import { todayStr } from '../lib/dates'
import { childrenOf } from '../lib/selectors'
import { CATEGORY_LABEL, PRIORITY_LABEL, type Category, type Priority, type Task, type TaskInput } from '../lib/types'
import { Sheet } from './ui'

/** タスクの追加・編集。task 未指定なら新規、parentId 指定で小項目として追加 */
export function TaskSheet({ task, parentId, defaultDate, onClose }: { task?: Task; parentId?: string; defaultDate?: string; onClose(): void }) {
  const app = useApp()
  const parent = app.tasks.find((t) => t.id === (task?.parent_id ?? parentId))
  const [f, setF] = useState<TaskInput>(() => task
    ? { title: task.title, description: task.description, assignee_id: task.assignee_id, priority: task.priority, category: task.category, due_date: task.due_date, due_time: task.due_time, parent_id: task.parent_id }
    : { title: '', description: '', assignee_id: parent?.assignee_id ?? app.user!.id, priority: 'medium', category: 'general', due_date: defaultDate ?? todayStr(), due_time: null, parent_id: parentId ?? null })
  const [subs, setSubs] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const kids = task ? childrenOf(app.tasks, task.id) : []
  const canAddChildren = !(task?.parent_id ?? parentId)
  const set = <K extends keyof TaskInput>(k: K, v: TaskInput[K]) => setF((p) => ({ ...p, [k]: v }))

  const assignable = app.isManager ? app.members.filter((m) => m.active) : app.members.filter((m) => m.user_id === app.user!.id)

  async function submit() {
    if (!f.title.trim()) return setErr('タスク名を入力してください')
    setBusy(true); setErr(null)
    try {
      const input = { ...f, title: f.title.trim(), due_date: f.due_date || null, due_time: f.due_time || null }
      if (task) await app.updateTask(task.id, input)
      else {
        const created = await app.createTask(input)
        if (canAddChildren) await createSubs(created)
      }
      onClose()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function createSubs(p: Task) {
    for (const title of subs.split('\n').map((s) => s.trim()).filter(Boolean)) {
      await app.createTask({ title, description: '', assignee_id: p.assignee_id, priority: p.priority, category: 'general', due_date: p.due_date, due_time: null, parent_id: p.id })
    }
    setSubs('')
  }

  async function addSubs() {
    if (!task || !subs.trim()) return
    setBusy(true); setErr(null)
    try { await createSubs(task) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function remove() {
    if (!task || !confirm(kids.length ? `小項目${kids.length}件も含めて削除しますか？（操作履歴は残ります）` : 'このタスクを削除しますか？（操作履歴は残ります）')) return
    setBusy(true)
    try { await app.deleteTask(task.id); onClose() } catch (e) { setErr((e as Error).message); setBusy(false) }
  }

  return (
    <Sheet title={task ? 'タスクを編集' : parent ? `小項目を追加（${parent.title}）` : 'タスクを追加'} onClose={onClose}>
      <div className="space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <label className="label">タスク名</label>
          <input className="field" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="例：広告動画を1本制作する" maxLength={200} autoFocus={!task} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">期限日</label>
            <input type="date" className="field" value={f.due_date ?? ''} onChange={(e) => set('due_date', e.target.value || null)} />
          </div>
          <div>
            <label className="label">時刻（任意）</label>
            <input type="time" className="field" value={f.due_time ?? ''} onChange={(e) => set('due_time', e.target.value || null)} />
          </div>
          <div>
            <label className="label">担当</label>
            <select className="field" value={f.assignee_id ?? ''} onChange={(e) => set('assignee_id', e.target.value || null)}>
              {app.isManager && <option value="">未割当（全員）</option>}
              {assignable.map((m) => <option key={m.user_id} value={m.user_id}>{m.profile.display_name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">優先度</label>
            <div className="flex gap-1">
              {(['high', 'medium', 'low'] as Priority[]).map((p) => (
                <button key={p} type="button" onClick={() => set('priority', p)}
                  className={`h-11 flex-1 rounded-xl border text-sm ${f.priority === p ? (p === 'high' ? 'border-red-500 bg-red-50 text-red-600' : 'border-ink bg-ink text-white') : 'border-neutral-200'}`}>
                  {PRIORITY_LABEL[p]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div>
          <label className="label">種類</label>
          <select className="field" value={f.category} onChange={(e) => set('category', e.target.value as Category)}>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="label">メモ</label>
          <textarea className="field h-20 py-2" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} />
          <p className="mt-1 text-[11px] text-neutral-400">※ 患者様の氏名・症状などの個人情報・医療情報は入力しないでください</p>
        </div>

        {canAddChildren && (
          <div className="rounded-2xl bg-neutral-50 p-3">
            <div className="label">小項目{task ? `（${kids.filter((k) => k.status === 'done').length}/${kids.length} 完了）` : '（任意・進捗率を自動計算）'}</div>
            {kids.map((k) => (
              <label key={k.id} className="flex items-center gap-2 py-1.5 text-sm">
                <input type="checkbox" className="h-5 w-5 accent-emerald-600" checked={k.status === 'done'} onChange={() => app.toggleDone(k)} />
                <span className={k.status === 'done' ? 'text-neutral-400 line-through' : ''}>{k.title}</span>
              </label>
            ))}
            <textarea className="field mt-2 h-20 py-2" placeholder={'1行に1つずつ入力\n例：企画完了\n動画撮影完了'} value={subs} onChange={(e) => setSubs(e.target.value)} />
            {task && <button className="btn-ghost mt-2 w-full" disabled={busy || !subs.trim()} onClick={addSubs}>小項目を追加</button>}
          </div>
        )}

        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex gap-2 pt-1">
          {task && <button className="btn-danger" disabled={busy} onClick={remove}>削除</button>}
          <button className="btn-primary flex-1" disabled={busy} onClick={submit}>{task ? '保存' : '追加'}</button>
        </div>
      </div>
    </Sheet>
  )
}
