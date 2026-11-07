import { useState } from 'react'
import { useApp } from '../lib/app'
import { addDays, endOfWeek, todayStr } from '../lib/dates'
import { childrenOf } from '../lib/selectors'
import { CATEGORY_LABEL, PRIORITY_LABEL, type Category, type Priority, type Task, type TaskInput } from '../lib/types'
import { ColorPicker, Sheet } from './ui'

const EVERYONE = '__everyone'

/** タスクの追加・編集。task 未指定なら新規、parentId 指定で小項目として追加 */
export function TaskSheet({ task, parentId, defaultDate, onClose }: { task?: Task; parentId?: string; defaultDate?: string; onClose(): void }) {
  const app = useApp()
  const parent = app.tasks.find((t) => t.id === (task?.parent_id ?? parentId))
  const [f, setF] = useState<TaskInput>(() => task
    ? { title: task.title, description: task.description, assignee_id: task.assignee_id, priority: task.priority, category: task.category, due_date: task.due_date, due_time: task.due_time, parent_id: task.parent_id, assignment_mode: task.assignment_mode, work_date: task.work_date, work_start: task.work_start, work_end: task.work_end, color_id: task.color_id ?? null }
    : { title: '', description: '', assignee_id: parent?.assignee_id ?? app.user!.id, priority: 'medium', category: 'general', due_date: defaultDate ?? todayStr(), due_time: null, parent_id: parentId ?? null, assignment_mode: 'single', work_date: null, work_start: null, work_end: null, color_id: parent?.color_id ?? null })
  const [subs, setSubs] = useState('')
  const [phase, setPhase] = useState<'idle' | 'saving'>('idle')
  const [err, setErr] = useState<string | null>(null)
  // 不要な項目は折りたたむ（既に値がある場合だけ最初から開く）
  const [details, setDetails] = useState(() => !!task && !!(task.due_time || task.work_start || task.description || task.category !== 'general' || task.color_id))
  const kids = task ? childrenOf(app.tasks, task.id) : []
  const isChild = !!(task?.parent_id ?? parentId)
  const busy = phase === 'saving'
  const set = <K extends keyof TaskInput>(k: K, v: TaskInput[K]) => setF((p) => ({ ...p, [k]: v }))

  const assignable = app.isManager ? app.members.filter((m) => m.active) : app.members.filter((m) => m.user_id === app.user!.id)
  const assigneeValue = f.assignment_mode === 'everyone' ? EVERYONE : f.assignee_id ?? ''
  const setAssignee = (v: string) => setF((p) => v === EVERYONE ? { ...p, assignment_mode: 'everyone', assignee_id: null } : { ...p, assignment_mode: 'single', assignee_id: v || null })

  const today = todayStr()
  const quick = [
    { label: '今日', v: today }, { label: '明日', v: addDays(today, 1) }, { label: '今週中', v: endOfWeek(today) }, { label: '期限なし', v: null },
  ]

  function validate(): string | null {
    if (!f.title.trim()) return 'タスク名を入力してください'
    if (!!f.work_start !== !!f.work_end) return '作業時間は開始と終了の両方を入力してください'
    if (f.work_start && f.work_end && f.work_end <= f.work_start) return '作業の終了時刻は開始より後にしてください'
    return null
  }

  async function submit() {
    const v = validate()
    if (v) return setErr(v)
    setPhase('saving'); setErr(null)
    try {
      const work = f.work_start ? { work_date: f.work_date || f.due_date || today } : { work_date: null, work_start: null, work_end: null }
      const input = { ...f, ...work, title: f.title.trim(), due_date: f.due_date || null, due_time: f.due_time || null }
      if (task) await app.updateTask(task.id, input)
      else {
        const created = await app.createTask(input)
        if (!isChild) await createSubs(created)
      }
      app.setToast({ message: task ? '保存しました' : 'タスクを追加しました', tone: 'success' })
      onClose()
    } catch (e) {
      setErr(`保存できませんでした。通信状況を確認して、もう一度「保存」を押してください。（${(e as Error).message}）`)
      setPhase('idle')
    }
  }

  async function createSubs(p: Task) {
    for (const title of subs.split('\n').map((s) => s.trim()).filter(Boolean)) {
      await app.createTask({ title, description: '', assignee_id: p.assignee_id, priority: p.priority, category: 'general', due_date: p.due_date, due_time: null, parent_id: p.id, assignment_mode: p.assignment_mode, work_date: null, work_start: null, work_end: null, color_id: p.color_id ?? null })
    }
    setSubs('')
  }

  async function addSubs() {
    if (!task || !subs.trim()) return
    setPhase('saving'); setErr(null)
    try { await createSubs(task); app.setToast({ message: '小項目を追加しました', tone: 'success' }) } catch (e) { setErr((e as Error).message) } finally { setPhase('idle') }
  }

  async function remove() {
    if (!task || !confirm(kids.length ? `小項目${kids.length}件も含めて削除しますか？（操作履歴は残ります）` : 'このタスクを削除しますか？（操作履歴は残ります）')) return
    setPhase('saving')
    try { await app.deleteTask(task.id); app.setToast({ message: '削除しました', tone: 'success' }); onClose() } catch (e) { setErr((e as Error).message); setPhase('idle') }
  }

  return (
    <Sheet title={task ? 'タスクを編集' : parent ? `小項目を追加（${parent.title}）` : 'タスクを追加'} onClose={onClose}>
      <div className="space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <label className="label">タスク名</label>
          <input className="field" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="例：広告動画を1本制作する" maxLength={200} autoFocus={!task} />
        </div>

        <div>
          <label className="label">期限</label>
          <div className="mb-2 grid grid-cols-4 gap-1.5">
            {quick.map((q) => (
              <button key={q.label} type="button" onClick={() => set('due_date', q.v)}
                className={`h-10 rounded-xl border text-sm ${f.due_date === q.v ? 'border-ink bg-ink text-white' : 'border-neutral-200 bg-white'}`}>{q.label}</button>
            ))}
          </div>
          <input type="date" className="field" value={f.due_date ?? ''} onChange={(e) => set('due_date', e.target.value || null)} aria-label="期限日" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">担当</label>
            <select className="field" value={assigneeValue} onChange={(e) => setAssignee(e.target.value)} aria-label="担当">
              {app.isManager && !isChild && <option value={EVERYONE}>全員が実施</option>}
              {app.isManager && <option value="">未割当（誰か1人）</option>}
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
        {f.assignment_mode === 'everyone' && <p className="-mt-2 text-[11px] text-sky-700">スタッフ全員が各自で完了にします。各自のGoogleカレンダーにも入ります。</p>}
        {f.assignment_mode === 'single' && !f.assignee_id && <p className="-mt-2 text-[11px] text-amber-700">誰か1人が完了にすれば完了です（Googleカレンダーには入りません）。</p>}

        <button type="button" className="min-h-11 text-sm text-neutral-500" onClick={() => setDetails(!details)}>{details ? '▴ 詳細を閉じる' : '▾ 詳細（時刻・作業時間・色・種類・メモ）'}</button>
        {details && (
          <div className="space-y-4 rounded-2xl bg-neutral-50 p-3">
            <div>
              <label className="label">締切時刻（任意）</label>
              <input type="time" className="field" value={f.due_time ?? ''} onChange={(e) => set('due_time', e.target.value || null)} aria-label="締切時刻" />
            </div>
            <div>
              <label className="label">作業する時間（任意・カレンダーにその時間帯の予定として入ります）</label>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <input type="time" className="field" value={f.work_start ?? ''} onChange={(e) => set('work_start', e.target.value || null)} aria-label="作業開始" />
                <span className="text-neutral-400">〜</span>
                <input type="time" className="field" value={f.work_end ?? ''} onChange={(e) => set('work_end', e.target.value || null)} aria-label="作業終了" />
              </div>
              {f.work_start && (
                <>
                  <label className="label mt-2">作業日</label>
                  <input type="date" className="field" value={f.work_date ?? f.due_date ?? ''} onChange={(e) => set('work_date', e.target.value || null)} aria-label="作業日" />
                </>
              )}
            </div>
            {!isChild && (
              <div>
                <label className="label">Googleカレンダーでの色</label>
                <ColorPicker value={f.color_id} onChange={(v) => set('color_id', v)} />
                <p className="mt-1 text-[11px] text-neutral-400">緑（バジル）は「完了」の目印のため選べません</p>
              </div>
            )}
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
          </div>
        )}

        {!isChild && (
          <div className="rounded-2xl bg-neutral-50 p-3">
            <div className="label">小項目{task ? `（${kids.filter((k) => k.status === 'done').length}/${kids.length} 完了）` : '（任意・進捗率を自動計算）'}</div>
            {kids.map((k) => (
              <label key={k.id} className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" className="h-5 w-5 accent-emerald-600" checked={k.status === 'done'} onChange={() => app.toggleDone(k)} />
                <span className={k.status === 'done' ? 'text-neutral-400 line-through' : ''}>{k.title}</span>
              </label>
            ))}
            <textarea className="field mt-2 h-20 py-2" placeholder={'1行に1つずつ入力\n例：企画完了\n動画撮影完了'} value={subs} onChange={(e) => setSubs(e.target.value)} />
            <p className="mt-1 text-[11px] text-neutral-400">Googleカレンダーでは、親タスクの予定の説明欄に一覧（☑/☐）で表示されます</p>
            {task && <button className="btn-ghost mt-2 w-full" disabled={busy || !subs.trim()} onClick={addSubs}>小項目を追加</button>}
          </div>
        )}

        {err && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        <div className="sticky bottom-0 -mx-1 flex gap-2 bg-white px-1 pt-1">
          {task && <button className="btn-danger" disabled={busy} onClick={remove}>削除</button>}
          <button className="btn-primary flex-1" disabled={busy} onClick={submit}>{busy ? '保存中…' : task ? '保存' : '追加'}</button>
        </div>
      </div>
    </Sheet>
  )
}
