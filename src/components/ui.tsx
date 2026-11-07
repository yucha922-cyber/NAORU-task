import type { ReactNode } from 'react'
import { EVENT_COLORS } from '../lib/types'

export function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center" onClick={onClose}>
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 pb-[calc(env(safe-area-inset-bottom)+20px)] sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="-mr-2 h-10 w-10 rounded-full text-xl text-neutral-400" onClick={onClose} aria-label="閉じる">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card px-4 py-8 text-center text-sm text-neutral-400">{children}</div>
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'red' | 'orange' | 'green' }) {
  const c = tone === 'red' ? 'text-red-600' : tone === 'orange' ? 'text-orange-500' : tone === 'green' ? 'text-emerald-600' : 'text-ink'
  return (
    <div className="card px-3 py-3">
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div className={`mt-0.5 text-2xl font-semibold tabular-nums ${c}`}>{value}</div>
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string; count?: number }[] }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {items.map((i) => (
        <button key={i.value} onClick={() => onChange(i.value)}
          className={`h-9 shrink-0 rounded-full border px-4 text-sm ${value === i.value ? 'border-ink bg-ink text-white' : 'border-neutral-200 bg-white text-neutral-600'}`}>
          {i.label}{i.count !== undefined && <span className="ml-1 tabular-nums opacity-70">{i.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Bar({ pct, tone = 'ink' }: { pct: number; tone?: 'ink' | 'green' }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
      <div className={`h-full rounded-full ${tone === 'green' ? 'bg-emerald-500' : 'bg-ink'}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Googleカレンダーの予定の色を選ぶ（グレー・緑は「完了」の目印のため選べない） */
export function ColorPicker({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="カレンダーの色">
      <button type="button" role="radio" aria-checked={value === null} aria-label="標準" onClick={() => onChange(null)}
        className={`flex h-9 items-center rounded-full border px-3 text-xs ${value === null ? 'border-ink bg-ink text-white' : 'border-neutral-200 bg-white text-neutral-600'}`}>標準</button>
      {EVENT_COLORS.map((c) => (
        <button key={c.id} type="button" role="radio" aria-checked={value === c.id} aria-label={c.name} title={c.name} onClick={() => onChange(c.id)}
          className={`h-9 w-9 rounded-full ${value === c.id ? 'ring-2 ring-ink ring-offset-2' : ''}`} style={{ backgroundColor: c.hex }} />
      ))}
    </div>
  )
}
