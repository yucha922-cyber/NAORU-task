import type { AssignmentMode, Member } from '../lib/types'

export interface Assignment {
  mode: AssignmentMode
  assigneeId: string | null
  groupIds: string[]
}

const EVERYONE = '__everyone'
const GROUP = '__group'

/**
 * 担当の選択（スタッフ・院長とも全メンバーから選べる）
 * - 個人 / 未割当（誰か1人）/ 全員が実施 / メンバーを選ぶ（2人以上・各自が完了）
 */
export function AssigneePicker({ value, onChange, members, allowMulti = true }: {
  value: Assignment
  onChange: (v: Assignment) => void
  members: Member[]
  allowMulti?: boolean
}) {
  const active = members.filter((m) => m.active)
  const selectValue = value.mode === 'everyone' ? EVERYONE : value.mode === 'group' ? GROUP : value.assigneeId ?? ''
  const onSelect = (v: string) => {
    if (v === EVERYONE) onChange({ mode: 'everyone', assigneeId: null, groupIds: [] })
    else if (v === GROUP) onChange({ mode: 'group', assigneeId: null, groupIds: value.groupIds.length ? value.groupIds : value.assigneeId ? [value.assigneeId] : [] })
    else onChange({ mode: 'single', assigneeId: v || null, groupIds: [] })
  }
  const toggle = (uid: string) => {
    const ids = value.groupIds.includes(uid) ? value.groupIds.filter((x) => x !== uid) : [...value.groupIds, uid]
    onChange({ ...value, groupIds: ids })
  }
  return (
    <div>
      <select className="field" value={selectValue} onChange={(e) => onSelect(e.target.value)} aria-label="担当">
        {active.map((m) => <option key={m.user_id} value={m.user_id}>{m.profile.display_name}</option>)}
        <option value="">未割当（誰か1人）</option>
        {allowMulti && <option value={GROUP}>メンバーを選ぶ（複数人）</option>}
        {allowMulti && <option value={EVERYONE}>全員が実施</option>}
      </select>
      {value.mode === 'group' && (
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="担当メンバー">
          {active.map((m) => {
            const on = value.groupIds.includes(m.user_id)
            return (
              <button key={m.user_id} type="button" aria-pressed={on} onClick={() => toggle(m.user_id)}
                className={`h-10 rounded-full border px-4 text-sm ${on ? 'border-ink bg-ink text-white' : 'border-neutral-200 bg-white'}`}>
                {on ? '✓ ' : ''}{m.profile.display_name}
              </button>
            )
          })}
        </div>
      )}
      <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
        {value.mode === 'everyone' && 'スタッフ全員が各自で完了にします。各自のGoogleカレンダーに入ります。'}
        {value.mode === 'group' && (value.groupIds.length < 2 ? '2人以上選んでください。' : `選んだ${value.groupIds.length}人が各自で完了にし、全員が終わると完了です。各自のGoogleカレンダーに入ります。`)}
        {value.mode === 'single' && !value.assigneeId && '誰か1人が完了にすれば完了です（Googleカレンダーには入りません）。'}
      </p>
    </div>
  )
}

/** 入力チェック（エラーメッセージ or null） */
export function validateAssignment(a: Assignment): string | null {
  if (a.mode === 'group' && a.groupIds.length < 2) return '「メンバーを選ぶ」は2人以上選んでください（1人の場合はその人を担当に選んでください）'
  return null
}
