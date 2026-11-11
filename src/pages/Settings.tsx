import { useEffect, useState } from 'react'
import { GoogleSyncPanel } from '../components/GoogleSyncPanel'
import { NotificationPanel } from '../components/NotificationPanel'
import { AssigneePicker, validateAssignment } from '../components/AssigneePicker'
import { notifyTemplatesChanged } from '../lib/recurrence'
import { ColorPicker, Empty, Sheet } from '../components/ui'
import { useApp } from '../lib/app'
import { repo } from '../lib/client'
import { todayStr } from '../lib/dates'
import { CATEGORY_LABEL, PRIORITY_LABEL, ROLE_LABEL, WEEKDAY_LABEL, type Activity, type Invitation, type Role, type TaskTemplate, type TemplateInput } from '../lib/types'

export function Settings() {
  const app = useApp()
  const me = app.members.find((m) => m.user_id === app.user!.id)
  const [name, setName] = useState(me?.profile.display_name ?? '')
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">管理設定</h1>

      <section className="card space-y-3 p-4">
        <div className="text-xs text-neutral-500">{app.user!.email}・{app.role && ROLE_LABEL[app.role]}</div>
        <div className="flex gap-2">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} placeholder="表示名" />
          <button className="btn-ghost shrink-0" onClick={async () => { await repo.updateMyName(name.trim()); app.reload(); app.setToast('表示名を変更しました') }}>保存</button>
        </div>
        {app.stores.length > 1 && (
          <select className="field" value={app.store?.id} onChange={(e) => app.selectStore(e.target.value)}>
            {app.stores.map((s) => <option key={s.store.id} value={s.store.id}>{s.store.name}</option>)}
          </select>
        )}
      </section>

      <NotificationPanel />
      <GoogleSyncPanel />
      {app.isManager && <Templates />}
      {app.role === 'admin' && <Members />}
      {app.isManager && <ActivityLog />}
      {app.isManager && <Backup />}

      <button className="btn-ghost w-full" onClick={() => repo.signOut()}>ログアウト</button>
      <a href={`${import.meta.env.BASE_URL}privacy.html`} className="block text-center text-xs text-neutral-400 underline">プライバシーポリシー</a>
      <p className="text-center text-[11px] text-neutral-400">
        NAORU TASK・{repo.mode === 'demo' ? 'デモモード' : 'Supabase接続'}・バージョン {new Date(__BUILD_TIME__).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </p>
    </div>
  )
}

function freqLabel(t: TaskTemplate) {
  switch (t.frequency) {
    case 'daily': return '毎日'
    case 'weekly': return `毎週 ${t.weekdays.map((d) => WEEKDAY_LABEL[d]).join('・')}`
    case 'interval': return `${t.interval_days}日ごと`
    case 'monthly': return `毎月 ${t.day_of_month === 31 ? '月末' : `${t.day_of_month}日`}`
  }
}

function Templates() {
  const app = useApp()
  const [list, setList] = useState<TaskTemplate[]>([])
  const [edit, setEdit] = useState<TaskTemplate | 'new' | null>(null)
  const load = () => repo.listTemplates(app.store!.id).then(setList).catch((e) => app.setToast(e.message))
  useEffect(() => { load() }, [app.store?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="section-title">繰り返しタスク</h2>
        <button className="mb-2 text-xs text-neutral-500" onClick={() => setEdit('new')}>＋ 追加</button>
      </div>
      <div className="card divide-y divide-neutral-100">
        {list.filter((t) => t.active).map((t) => (
          <button key={t.id} className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => setEdit(t)}>
            <div>
              <div className="text-sm">{t.title}</div>
              <div className="text-[11px] text-neutral-500">{freqLabel(t)}{t.due_time && ` ${t.due_time}まで`}・{t.assignment_mode === 'everyone' ? '全員' : t.assignment_mode === 'group' ? (t.assignee_ids ?? []).map((id) => app.memberName(id)).join('・') : t.assignee_id ? app.memberName(t.assignee_id) : '誰か1人'}</div>
            </div>
            <span className="text-neutral-300">›</span>
          </button>
        ))}
        {!list.some((t) => t.active) && <div className="px-4 py-6 text-center text-sm text-neutral-400">未登録</div>}
      </div>
      <p className="mt-1 px-1 text-[11px] text-neutral-400">アプリを開いた時に今日・明日の分を自動生成します（重複生成なし。未実行日は最大7日分まで自動復旧）</p>
      {edit && <TemplateSheet tpl={edit === 'new' ? undefined : edit} onClose={() => { setEdit(null); load() }} />}
    </section>
  )
}

function TemplateSheet({ tpl, onClose }: { tpl?: TaskTemplate; onClose(): void }) {
  const app = useApp()
  const [f, setF] = useState<TemplateInput>(() => tpl ? { ...tpl } : {
    title: '', description: '', assignee_id: null, priority: 'medium', category: 'general', frequency: 'daily',
    interval_days: 3, weekdays: [1], day_of_month: 1, due_time: null, start_date: todayStr(), end_date: null, active: true, assignment_mode: 'single', color_id: null, assignee_ids: [],
  })
  const [err, setErr] = useState<string | null>(null)
  const set = <K extends keyof TemplateInput>(k: K, v: TemplateInput[K]) => setF((p) => ({ ...p, [k]: v }))
  async function save() {
    if (!f.title.trim()) return setErr('タスク名を入力してください')
    if (f.frequency === 'weekly' && !f.weekdays.length) return setErr('曜日を選択してください')
    const v = validateAssignment({ mode: f.assignment_mode, assigneeId: f.assignee_id, groupIds: f.assignee_ids ?? [] })
    if (v) return setErr(v)
    try {
      const { ...input } = f
      delete (input as Partial<TaskTemplate>).id; delete (input as Partial<TaskTemplate>).store_id; delete (input as Partial<TaskTemplate>).last_generated_date
      await repo.saveTemplate(app.store!.id, { ...input, assignee_ids: f.assignment_mode === 'group' ? f.assignee_ids ?? [] : [], title: f.title.trim(), due_time: f.due_time || null, end_date: f.end_date || null }, tpl?.id)
      await repo.generateRecurring(app.store!.id)
      notifyTemplatesChanged()
      await app.reload()
      onClose()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <Sheet title={tpl ? '繰り返しタスクを編集' : '繰り返しタスクを追加'} onClose={onClose}>
      <div className="space-y-4">
        <div><label className="label">タスク名</label><input className="field" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="例：日報提出" /></div>
        <div><label className="label">担当</label>
          <AssigneePicker members={app.members}
            value={{ mode: f.assignment_mode, assigneeId: f.assignee_id, groupIds: f.assignee_ids ?? [] }}
            onChange={(a) => setF((p) => ({ ...p, assignment_mode: a.mode, assignee_id: a.mode === 'single' ? a.assigneeId : null, assignee_ids: a.groupIds }))} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">種類</label>
            <select className="field" value={f.category} onChange={(e) => set('category', e.target.value as TemplateInput['category'])}>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
          <div><label className="label">頻度</label>
            <select className="field" value={f.frequency} onChange={(e) => set('frequency', e.target.value as TemplateInput['frequency'])}>
              <option value="daily">毎日</option><option value="weekly">毎週（曜日指定）</option><option value="interval">◯日ごと</option><option value="monthly">毎月</option>
            </select></div>
          <div><label className="label">期限時刻（任意）</label><input type="time" className="field" value={f.due_time ?? ''} onChange={(e) => set('due_time', e.target.value || null)} /></div>
        </div>
        {f.frequency === 'weekly' && (
          <div className="flex gap-1">
            {WEEKDAY_LABEL.map((w, i) => (
              <button key={w} type="button" onClick={() => set('weekdays', f.weekdays.includes(i) ? f.weekdays.filter((x) => x !== i) : [...f.weekdays, i].sort())}
                className={`h-10 flex-1 rounded-xl border text-sm ${f.weekdays.includes(i) ? 'border-ink bg-ink text-white' : 'border-neutral-200'}`}>{w}</button>
            ))}
          </div>
        )}
        {f.frequency === 'interval' && (
          <div><label className="label">間隔（日）</label><input type="number" min={1} max={365} className="field" value={f.interval_days ?? 1} onChange={(e) => set('interval_days', Math.max(1, Number(e.target.value)))} /></div>
        )}
        {f.frequency === 'monthly' && (
          <div><label className="label">日付（31=月末）</label><input type="number" min={1} max={31} className="field" value={f.day_of_month ?? 1} onChange={(e) => set('day_of_month', Math.min(31, Math.max(1, Number(e.target.value))))} /></div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">開始日</label><input type="date" className="field" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} /></div>
          <div><label className="label">終了日（任意）</label><input type="date" className="field" value={f.end_date ?? ''} onChange={(e) => set('end_date', e.target.value || null)} /></div>
        </div>
        <div><label className="label">優先度</label>
          <select className="field" value={f.priority} onChange={(e) => set('priority', e.target.value as TemplateInput['priority'])}>
            {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></div>
        <div><label className="label">Googleカレンダーでの色</label><ColorPicker value={f.color_id ?? null} onChange={(v) => set('color_id', v)} /></div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex gap-2">
          {tpl && <button className="btn-danger" onClick={async () => { if (confirm('停止しますか？（生成済みのタスクは残ります）')) { await repo.deleteTemplate(tpl.id); notifyTemplatesChanged(); onClose() } }}>停止</button>}
          <button className="btn-primary flex-1" onClick={save}>保存</button>
        </div>
      </div>
    </Sheet>
  )
}

function Members() {
  const app = useApp()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [err, setErr] = useState<string | null>(null)
  const [invites, setInvites] = useState<Invitation[]>([])
  const loadInvites = () => repo.listInvitations(app.store!.id).then(setInvites).catch(() => {})
  useEffect(() => { loadInvites() }, [app.store?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section>
      <h2 className="section-title">スタッフ・権限</h2>
      <div className="card divide-y divide-neutral-100">
        {app.members.map((m) => (
          <div key={m.id} className={`flex items-center gap-2 px-4 py-3 ${m.active ? '' : 'opacity-50'}`}>
            <div className="min-w-0 flex-1">
              <div className="text-sm">{m.profile.display_name}</div>
              <div className="truncate text-[11px] text-neutral-400">{m.profile.email}</div>
            </div>
            {m.user_id === app.user!.id ? <span className="text-xs text-neutral-500">{ROLE_LABEL[m.role]}（自分）</span> : (
              <>
                <select className="h-9 rounded-lg border border-neutral-200 px-2 text-sm" value={m.role}
                  onChange={async (e) => { await repo.updateMember(m.id, { role: e.target.value as Role }); app.reload() }}>
                  {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <button className="h-9 rounded-lg px-2 text-xs text-neutral-500" onClick={async () => { await repo.updateMember(m.id, { active: !m.active }); app.reload() }}>{m.active ? '無効化' : '有効化'}</button>
              </>
            )}
          </div>
        ))}
        {invites.map((i) => (
          <div key={i.email} className="flex items-center gap-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm"><span className="chip bg-amber-50 text-amber-700">招待中</span>{ROLE_LABEL[i.role]}</div>
              <div className="truncate text-[11px] text-neutral-400">{i.email}（本人がアカウント登録すると自動で参加）</div>
            </div>
            <button className="h-9 rounded-lg px-2 text-xs text-neutral-500" onClick={async () => {
              if (!confirm(`${i.email} への招待を取り消しますか？`)) return
              await repo.cancelInvitation(app.store!.id, i.email); loadInvites()
            }}>取り消し</button>
          </div>
        ))}
        <div className="space-y-2 p-4">
          <div className="text-xs text-neutral-500">スタッフを追加（未登録のメールアドレスも追加できます。本人がそのアドレスでアカウント登録すると、自動でこの店舗に参加します）</div>
          <input type="email" className="field" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="flex gap-2">
            <select className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button className="btn-primary shrink-0" disabled={!email} onClick={async () => {
              setErr(null)
              try {
                const r = await repo.addMember(app.store!.id, email, role)
                setEmail(''); app.reload(); loadInvites()
                app.setToast({ tone: 'success', message: r === 'added' ? '追加しました' : '招待しました。本人がこのメールアドレスでアカウント登録すると、自動でこの店舗に参加します' })
              } catch (e) { setErr((e as Error).message) }
            }}>追加</button>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      </div>
    </section>
  )
}

const ACTION_LABEL = { create: '作成', update: '編集', complete: '完了', reopen: '未完了に戻す', delete: '削除' }

function ActivityLog() {
  const app = useApp()
  const [rows, setRows] = useState<Activity[] | null>(null)
  return (
    <section>
      <h2 className="section-title">操作履歴</h2>
      {rows === null ? (
        <button className="btn-ghost w-full" onClick={() => repo.listActivity(app.store!.id, 50).then(setRows).catch((e) => app.setToast(e.message))}>直近50件を表示</button>
      ) : rows.length ? (
        <div className="card divide-y divide-neutral-100">
          {rows.map((a) => (
            <div key={a.id} className="px-4 py-2.5 text-sm">
              <span className="font-medium">{app.memberName(a.actor_id)}</span>
              <span className="text-neutral-500"> が「{a.task_title}」を{ACTION_LABEL[a.action]}</span>
              <div className="text-[11px] text-neutral-400">{new Date(a.created_at).toLocaleString('ja-JP')}{Object.keys(a.changes).length > 0 && `・変更: ${Object.keys(a.changes).join(', ')}`}</div>
            </div>
          ))}
        </div>
      ) : <Empty>履歴はありません</Empty>}
    </section>
  )
}

function Backup() {
  const app = useApp()
  return (
    <section>
      <h2 className="section-title">バックアップ</h2>
      <div className="card space-y-2 p-4">
        <p className="text-xs leading-relaxed text-neutral-500">店舗の全データ（タスク・繰り返し設定・操作履歴）をJSONファイルで保存します。月1回程度の保存を推奨します。復元手順は docs/OPERATIONS.md を参照してください。</p>
        <button className="btn-ghost w-full" onClick={async () => {
          try {
            const data = await repo.exportStore(app.store!.id)
            const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), version: 1, ...data }, null, 2)], { type: 'application/json' })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = `naoru-task-backup-${todayStr()}.json`
            a.click()
            URL.revokeObjectURL(a.href)
          } catch (e) { app.setToast((e as Error).message) }
        }}>バックアップをダウンロード</button>
      </div>
    </section>
  )
}
