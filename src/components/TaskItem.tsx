import { useState } from 'react'
import { useApp } from '../lib/app'
import { dueState, labelDate } from '../lib/dates'
import { childrenOf, progress } from '../lib/selectors'
import { everyoneProgress, isAssignedTo, isMulti, statusFor } from '../lib/responsibility'
import { CATEGORY_LABEL, colorHex, type Task } from '../lib/types'
import { Bar } from './ui'
import { TaskSheet } from './TaskSheet'

const tone = {
  overdue: 'text-red-600',
  soon: 'text-orange-500',
  done: 'text-emerald-600',
  normal: 'text-neutral-500',
  none: 'text-neutral-400',
}

export function CheckButton({ task }: { task: Task }) {
  const { toggleDone, user, setToast } = useApp()
  const status = statusFor(task, user!.id)
  const done = status === 'done'
  const st = dueState({ status, due_date: task.due_date })
  // 全員向けタスクで自分が対象外（例: 院長が全体を見ている）の場合は押せない
  const locked = isMulti(task) && !isAssignedTo(task, user!.id)
  const ring = done ? 'border-emerald-500 bg-emerald-500 text-white' : st === 'overdue' ? 'border-red-400' : st === 'soon' ? 'border-orange-400' : 'border-neutral-300'
  return (
    <button onClick={(e) => { e.stopPropagation(); if (locked) setToast({ message: '全員向けタスクは、各自が自分の分を完了にします', tone: 'info' }); else toggleDone(task) }}
      aria-label={done ? '未完了に戻す' : '完了にする'} aria-disabled={locked}
      className="-m-2 flex h-12 w-12 shrink-0 items-center justify-center">
      <span className={`flex h-7 w-7 items-center justify-center rounded-full border-2 ${ring} ${locked ? 'border-dashed opacity-60' : ''}`}>
        {done && <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3.5 8.5l3 3 6-7" /></svg>}
      </span>
    </button>
  )
}

export function TaskItem({ task, showAssignee = true, compact = false }: { task: Task; showAssignee?: boolean; compact?: boolean }) {
  const { tasks, memberName, user } = useApp()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const myStatus = statusFor(task, user!.id)
  const st = dueState({ status: myStatus, due_date: task.due_date })
  const ev = everyoneProgress(task)
  const prog = progress(tasks, task.id)
  const kids = expanded ? childrenOf(tasks, task.id) : []
  const border = st === 'overdue' ? 'border-l-red-500' : st === 'soon' ? 'border-l-orange-400' : st === 'done' ? 'border-l-emerald-500' : 'border-l-transparent'

  return (
    <div className={`card overflow-hidden border-l-4 ${border}`}>
      <div className="flex items-start gap-3 px-3 py-3" onClick={() => setOpen(true)}>
        <CheckButton task={task} />
        <div className="min-w-0 flex-1">
          <div className={`flex items-center gap-1.5 text-[15px] leading-snug ${myStatus === 'done' ? 'text-neutral-400 line-through' : ''}`}>
            {colorHex(task.color_id) && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorHex(task.color_id)! }} title="Googleカレンダーでの色" />}
            <span>{task.title}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className={`font-medium ${tone[st]}`}>
              {st === 'overdue' && '期限超過・'}{labelDate(task.due_date)}{task.due_time && ` ${task.due_time}`}
            </span>
            {task.priority === 'high' && <span className="chip bg-red-50 text-red-600">優先度 高</span>}
            {task.category !== 'general' && !compact && <span className="chip bg-neutral-100 text-neutral-600">{CATEGORY_LABEL[task.category]}</span>}
            {task.template_id && !compact && <span className="text-neutral-400" title="繰り返し">↻</span>}
            {task.work_start && <span className="text-neutral-500">作業 {task.work_date !== task.due_date ? labelDate(task.work_date) + ' ' : ''}{task.work_start}〜{task.work_end}</span>}
            {ev ? <span className="chip bg-sky-50 text-sky-700">{task.assignment_mode === 'everyone' ? '全員' : task.assignees.map((a) => memberName(a.user_id)).join('・')} {ev.done}/{ev.total}</span>
              : showAssignee && <span className={task.assignee_id ? 'text-neutral-500' : 'chip bg-amber-50 text-amber-700'}>{task.assignee_id ? memberName(task.assignee_id) : '未割当・誰か1人'}</span>}
          </div>
          {prog && (
            <button className="mt-2 flex w-full items-center gap-2 text-left" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}>
              <Bar pct={prog.pct} tone={prog.pct === 100 ? 'green' : 'ink'} />
              <span className="shrink-0 text-xs tabular-nums text-neutral-500">{prog.done}/{prog.total}（{prog.pct}%）{expanded ? '▴' : '▾'}</span>
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-neutral-100 bg-neutral-50/60 py-1 pl-10">
          {kids.map((k) => <SubItem key={k.id} task={k} />)}
        </div>
      )}
      {open && <TaskSheet task={task} onClose={() => setOpen(false)} />}
    </div>
  )
}

function SubItem({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const st = dueState(task)
  return (
    <div className="flex items-center gap-3 px-3 py-1.5" onClick={() => setOpen(true)}>
      <CheckButton task={task} />
      <span className={`flex-1 text-sm ${task.status === 'done' ? 'text-neutral-400 line-through' : ''}`}>{task.title}</span>
      {task.due_date && <span className={`text-xs ${tone[st]}`}>{labelDate(task.due_date)}</span>}
      {open && <TaskSheet task={task} onClose={() => setOpen(false)} />}
    </div>
  )
}
