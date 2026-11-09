import { useState } from 'react'
import { useApp } from '../lib/app'
import { addDays, endOfWeek, todayStr, weekday } from '../lib/dates'
import { repo } from '../lib/client'
import { notifyTemplatesChanged } from '../lib/recurrence'
import { childrenOf } from '../lib/selectors'
import { CATEGORY_LABEL, PRIORITY_LABEL, WEEKDAY_LABEL, type Category, type Frequency, type Priority, type Task, type TaskInput } from '../lib/types'
import { ColorPicker, Sheet } from './ui'
import { AssigneePicker, validateAssignment, type Assignment } from './AssigneePicker'

const f0Mode = (t?: Task) => t?.assignment_mode ?? 'single'


/** タスクの追加・編集。task 未指定なら新規、parentId 指定で小項目として追加 */
export function TaskSheet({ task, parentId, defaultDate, onClose }: { task?: Task; parentId?: string; defaultDate?: string; onClose(): void }) {
  const app = useApp()
  const parent = app.tasks.find((t) => t.id === (task?.parent_id ?? parentId))
  const [f, setF] = useState<TaskInput>(() => task
    ? { title: task.title, description: task.description, assignee_id: task.assignee_id, priority: task.priority, category: task.category, due_date: task.due_date, due_time: task.due_time, parent_id: task.parent_id, assignment_mode: task.assignment_mode, work_date: task.work_date, work_start: task.work_start, work_end: task.work_end, color_id: task.color_id ?? null }
    : { title: '', description: '', assignee_id: parent?.assignee_id ?? app.user!.id, priority: 'medium', category: 'general', due_date: defaultDate ?? todayStr(), due_time: null, parent_id: parentId ?? null, assignment_mode: 'single', work_date: null, work_start: null, work_end: null, color_id: parent?.color_id ?? null })
  const [subs, setSubs] = useState('')
  // 担当（「メンバーを選ぶ」の場合は複数人）
  const [assign, setAssign] = useState<Assignment>(() => ({
    mode: f0Mode(task), assigneeId: task ? task.assignee_id : parent?.assignee_id ?? app.user!.id,
    groupIds: task?.assignment_mode === 'group' ? task.assignees.map((a) => a.user_id) : parent?.assignment_mode === 'group' ? parent.assignees.map((a) => a.user_id) : [],
  }))
  // 繰り返し（新規の大項目のみ・院長/管理者）。設定すると繰り返しタスクとして登録する
  const [repeat, setRepeat] = useState<'none' | Frequency>('none')
  const [weekdays, setWeekdays] = useState<number[]>([])
  const [intervalDays, setIntervalDays] = useState(3)
  const [phase, setPhase] = useState<'idle' | 'saving'>('idle')
  const [err, setErr] = useState<string | null>(null)
  // 不要な項目は折りたたむ（既に値がある場合だけ最初から開く）
  const [details, setDetails] = useState(() => !!task && !!(task.due_time || task.work_start || task.description || task.category !== 'general' || task.color_id))
  const kids = task ? childrenOf(app.tasks, task.id) : []
  const isChild = !!(task?.parent_id ?? parentId)
  const busy = phase === 'saving'
  const canRepeat = !task && !isChild && app.isManager
  const repeating = canRepeat && repeat !== 'none'
  const startDay = f.due_date || todayStr()
  const repeatSummary = `${Number(startDay.slice(5, 7))}/${Number(startDay.slice(8, 10))}` + (
    repeat === 'monthly' ? `（毎月${Number(startDay.slice(8, 10))}日）` : repeat === 'weekly' ? '' : repeat === 'interval' ? `（${intervalDays}日ごと）` : '')
  const set = <K extends keyof TaskInput>(k: K, v: TaskInput[K]) => setF((p) => ({ ...p, [k]: v }))

  const onAssign = (a: Assignment) => {
    setAssign(a)
    setF((p) => ({ ...p, assignment_mode: a.mode, assignee_id: a.mode === 'single' ? a.assigneeId : null }))
  }

  const today = todayStr()
  const quick = [
    { label: '今日', v: today }, { label: '明日', v: addDays(today, 1) }, { label: '今週中', v: endOfWeek(today) }, { label: '期限なし', v: null },
  ]

  function validate(): string | null {
    if (!f.title.trim()) return 'タスク名を入力してください'
    if (!!f.work_start !== !!f.work_end) return '作業時間は開始と終了の両方を入力してください'
    if (f.work_start && f.work_end && f.work_end <= f.work_start) return '作業の終了時刻は開始より後にしてください'
    return validateAssignment(assign)
  }

  async function submit() {
    const v = validate()
    if (v) return setErr(v)
    setPhase('saving'); setErr(null)
    try {
      if (repeating) {
        await createRepeating()
        return
      }
      const work = f.work_start ? { work_date: f.work_date || f.due_date || today } : { work_date: null, work_start: null, work_end: null }
      const input = { ...f, ...work, title: f.title.trim(), due_date: f.due_date || null, due_time: f.due_time || null }
      if (task) {
        await app.updateTask(task.id, input)
        if (assign.mode === 'group') { await repo.setAssignees(task.id, assign.groupIds); await app.reload() }
      } else {
        const created = await app.createTask(input)
        if (assign.mode === 'group') await repo.setAssignees(created.id, assign.groupIds)
        if (!isChild) await createSubs(created)
        if (assign.mode === 'group') await app.reload()
      }
      app.setToast({ message: task ? '保存しました' : 'タスクを追加しました', tone: 'success' })
      onClose()
    } catch (e) {
      setErr(`保存できませんでした。通信状況を確認して、もう一度「保存」を押してください。（${(e as Error).message}）`)
      setPhase('idle')
    }
  }

  async function createRepeating() {
    const start = f.due_date || today
    await repo.saveTemplate(app.store!.id, {
      title: f.title.trim(), description: f.description, assignee_id: assign.mode === 'single' ? assign.assigneeId : null,
      priority: f.priority, category: f.category, frequency: repeat as Frequency,
      interval_days: repeat === 'interval' ? intervalDays : null,
      weekdays: repeat === 'weekly' ? (weekdays.length ? weekdays : [weekday(start)]) : [],
      day_of_month: repeat === 'monthly' ? Number(start.slice(8, 10)) : null,
      due_time: f.due_time || null, start_date: start, end_date: null, active: true,
      assignment_mode: assign.mode, color_id: f.color_id, assignee_ids: assign.mode === 'group' ? assign.groupIds : [],
    })
    await repo.generateRecurring(app.store!.id)
    notifyTemplatesChanged()
    await app.reload()
    app.setToast({ message: `繰り返しタスク「${f.title.trim()}」を登録しました`, tone: 'success' })
    onClose()
  }

  async function createSubs(p: Task) {
    for (const title of subs.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const c = await app.createTask({ title, description: '', assignee_id: p.assignee_id, priority: p.priority, category: 'general', due_date: p.due_date, due_time: null, parent_id: p.id, assignment_mode: p.assignment_mode, work_date: null, work_start: null, work_end: null, color_id: p.color_id ?? null })
      if (c.assignment_mode === 'group') await repo.setAssignees(c.id, assign.mode === 'group' ? assign.groupIds : p.assignees.map((a) => a.user_id))
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

        <div>
          <label className="label">担当</label>
          <AssigneePicker value={assign} onChange={onAssign} members={app.members} />
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

        {canRepeat && (
          <div>
            <label className="label">繰り返し</label>
            <div className="grid grid-cols-5 gap-1.5">
              {([['none', 'なし'], ['daily', '毎日'], ['weekly', '毎週'], ['interval', '◯日ごと'], ['monthly', '毎月']] as const).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setRepeat(v)}
                  className={`h-10 rounded-xl border text-xs ${repeat === v ? 'border-ink bg-ink text-white' : 'border-neutral-200 bg-white'}`}>{l}</button>
              ))}
            </div>
            {repeat === 'weekly' && (
              <div className="mt-2 flex gap-1">
                {WEEKDAY_LABEL.map((w, i) => {
                  const on = weekdays.length ? weekdays.includes(i) : weekday(f.due_date || today) === i
                  return (
                    <button key={w} type="button" onClick={() => setWeekdays((cur) => { const base = cur.length ? cur : [weekday(f.due_date || today)]; return base.includes(i) ? base.filter((x) => x !== i) : [...base, i].sort() })}
                      className={`h-10 flex-1 rounded-xl border text-sm ${on ? 'border-ink bg-ink text-white' : 'border-neutral-200'}`}>{w}</button>
                  )
                })}
              </div>
            )}
            {repeat === 'interval' && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                <input type="number" min={2} max={365} className="field w-24" value={intervalDays} onChange={(e) => setIntervalDays(Math.min(365, Math.max(1, Number(e.target.value) || 1)))} aria-label="間隔（日）" />
                <span>日ごと</span>
              </div>
            )}
            {repeating && (
              <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
                {repeatSummary}から繰り返します。各回のタスクは前日に自動で作られます（Googleカレンダーにもその時点で反映）。
                作業時間・小項目は繰り返しでは使えません。変更・停止は「設定」→「繰り返しタスク」から。
              </p>
            )}
          </div>
        )}

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
                <p className="mt-1 text-[11px] text-neutral-400">グレー（グラファイト）と緑（バジル）は「完了」の目印のため選べません</p>
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

        {!isChild && !repeating && (
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
          <button className="btn-primary flex-1" disabled={busy} onClick={submit}>{busy ? '保存中…' : task ? '保存' : repeating ? '繰り返しで追加' : '追加'}</button>
        </div>
      </div>
    </Sheet>
  )
}
