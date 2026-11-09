import type { Member } from '../lib/types'

/** 院長・管理者用: 表示するスタッフを絞り込む（空 = 全員） */
export function StaffFilter({ members, value, onChange }: { members: Member[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="radiogroup" aria-label="スタッフで絞り込み">
      {[{ id: '', name: '全員' }, ...members.filter((m) => m.active).map((m) => ({ id: m.user_id, name: m.profile.display_name }))].map((o) => (
        <button key={o.id || 'all'} role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}
          className={`h-9 shrink-0 rounded-full border px-4 text-sm ${value === o.id ? 'border-ink bg-ink text-white' : 'border-neutral-200 bg-white text-neutral-600'}`}>{o.name}</button>
      ))}
    </div>
  )
}
