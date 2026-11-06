import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Repo, SessionUser } from './repo'
import type { Activity, CalendarLink, Member, Role, Store, Task, TaskTemplate } from './types'

const JA: [RegExp, string][] = [
  [/Invalid login credentials/i, 'メールアドレスまたはパスワードが違います'],
  [/User already registered/i, 'このメールアドレスは既に登録されています。ログインしてください'],
  [/Password should be at least/i, 'パスワードが短すぎます（8文字以上にしてください）'],
  [/Email not confirmed/i, 'メールアドレスの確認が完了していません'],
  [/rate limit/i, '短時間に操作が集中しました。しばらく待ってから再度お試しください'],
  [/Failed to fetch|NetworkError/i, '通信できませんでした。電波状況を確認してください'],
]
const ja = (m: string) => JA.find(([r]) => r.test(m))?.[1] ?? m

function check<T>(r: { data: T; error: { message: string } | null } | { data: unknown; error: { message: string } }): T {
  if (r.error) throw new Error(ja(r.error.message))
  return r.data as T
}

const trimTime = <T extends { due_time: string | null }>(t: T): T => ({ ...t, due_time: t.due_time ? t.due_time.slice(0, 5) : null })

export function createSupabaseRepo(url: string, key: string): Repo {
  const sb: SupabaseClient = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } })
  const toUser = (u: { id: string; email?: string } | null | undefined): SessionUser | null => (u ? { id: u.id, email: u.email ?? '' } : null)
  const uid = async () => {
    const { data } = await sb.auth.getSession()
    if (!data.session) throw new Error('ログインが必要です')
    return data.session.user.id
  }

  return {
    mode: 'supabase',
    async getUser() {
      const { data } = await sb.auth.getSession()
      return toUser(data.session?.user)
    },
    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_e, s) => cb(toUser(s?.user)))
      return () => data.subscription.unsubscribe()
    },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }))
    },
    async signUp(email, password, displayName) {
      check(await sb.auth.signUp({ email, password, options: { data: { display_name: displayName } } }))
    },
    async signOut() {
      await sb.auth.signOut()
    },

    async myStores() {
      const me = await uid()
      const rows = check(await sb.from('memberships').select('role, store:stores(id,name,timezone)').eq('user_id', me).eq('active', true))
      return (rows as unknown as { role: Role; store: Store }[]).map((r) => ({ store: r.store, role: r.role }))
    },
    async createStore(name) {
      return check(await sb.rpc('create_store', { p_name: name })) as string
    },
    async listMembers(storeId) {
      const rows = check(await sb.from('memberships').select('*, profile:profiles(id,email,display_name)').eq('store_id', storeId))
      return rows as Member[]
    },
    async addMember(storeId, email, role) {
      check(await sb.rpc('add_member_by_email', { p_store: storeId, p_email: email, p_role: role }))
    },
    async updateMember(id, patch) {
      check(await sb.from('memberships').update(patch).eq('id', id))
    },
    async updateMyName(name) {
      check(await sb.from('profiles').update({ display_name: name }).eq('id', await uid()))
    },

    async listTasks(storeId, recentDays) {
      const since = new Date(Date.now() - recentDays * 86400000).toISOString()
      // 1クエリで取得（未完了 or 直近完了）。通信量を抑えるため必要件数に上限
      const rows = check(
        await sb.from('tasks').select('*').eq('store_id', storeId).is('deleted_at', null)
          .or(`status.eq.open,completed_at.gte.${since}`).order('due_date', { ascending: true, nullsFirst: false }).limit(2000),
      )
      return (rows as Task[]).map(trimTime)
    },
    async listHistory(storeId, offset, limit) {
      const rows = check(
        await sb.from('tasks').select('*').eq('store_id', storeId).eq('status', 'done').is('deleted_at', null)
          .order('completed_at', { ascending: false }).range(offset, offset + limit - 1),
      )
      return (rows as Task[]).map(trimTime)
    },
    async createTask(storeId, input) {
      const row = check(await sb.from('tasks').insert({ ...input, store_id: storeId, created_by: await uid() }).select().single())
      return trimTime(row as Task)
    },
    async updateTask(id, patch) {
      return trimTime(check(await sb.from('tasks').update(patch).eq('id', id).select().single()) as Task)
    },
    async setDone(id, done) {
      return trimTime(check(await sb.from('tasks').update({ status: done ? 'done' : 'open' }).eq('id', id).select().single()) as Task)
    },
    async deleteTask(id) {
      const now = new Date().toISOString()
      check(await sb.from('tasks').update({ deleted_at: now }).eq('parent_id', id))
      check(await sb.from('tasks').update({ deleted_at: now }).eq('id', id))
    },

    async listTemplates(storeId) {
      const rows = check(await sb.from('task_templates').select('*').eq('store_id', storeId).order('created_at'))
      return (rows as TaskTemplate[]).map(trimTime)
    },
    async saveTemplate(storeId, input, id) {
      if (id) check(await sb.from('task_templates').update(input).eq('id', id))
      else check(await sb.from('task_templates').insert({ ...input, store_id: storeId, created_by: await uid() }))
    },
    async deleteTemplate(id) {
      // 生成済みタスクは残し、テンプレートは停止扱い（履歴保全）
      check(await sb.from('task_templates').update({ active: false }).eq('id', id))
    },
    async generateRecurring(storeId) {
      return check(await sb.rpc('generate_recurring_tasks', { p_store: storeId })) as number
    },

    async listActivity(storeId, limit) {
      return check(await sb.from('task_activity').select('*').eq('store_id', storeId).order('created_at', { ascending: false }).limit(limit)) as Activity[]
    },

    async listCalendarLinks(storeId) {
      return check(await sb.from('task_calendar_links').select('*').eq('store_id', storeId).eq('user_id', await uid())) as CalendarLink[]
    },
    async saveCalendarLink(link) {
      check(await sb.from('task_calendar_links').upsert(link))
    },

    async exportStore(storeId) {
      const out: Record<string, unknown[]> = {}
      for (const t of ['stores', 'memberships', 'tasks', 'task_templates', 'task_activity'] as const) {
        const col = t === 'stores' ? 'id' : 'store_id'
        const all: unknown[] = []
        for (let from = 0; ; from += 1000) {
          const rows = check(await sb.from(t).select('*').eq(col, storeId).range(from, from + 999)) as unknown[]
          all.push(...rows)
          if (rows.length < 1000) break
        }
        out[t] = all
      }
      return out
    },
  }
}
