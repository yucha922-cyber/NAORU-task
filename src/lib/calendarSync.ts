/**
 * Googleカレンダー同期エンジン（アプリ → Google の一方向）。
 * Google API と DB 操作を引数で受け取る純粋なロジックにして、モックで単体テストできるようにしている。
 *
 * 安全性・確実性の設計
 * - 同期対象は「ログイン中のユーザー本人が実施すべきタスク」だけ（他人のカレンダーには書かない）
 * - 同期先は本人の Google アカウントに作った専用カレンダー「NAORU TASK」だけ（ID は DB で管理し端末間で共有）
 * - 予定 ID をタスク ID から決定的に生成 → 複数端末が同時に同期しても重複予定ができない
 * - 「あるべき状態」と DB の対応表を毎回突き合わせる → 他人が編集・削除・担当変更した分も本人の次回同期で反映
 * - 予定の削除は対応表（task_calendar_links）に基づき、タスクが削除・担当外・期限なしになったら削除
 */
import { addDays } from './dates'
import { isAssignedTo, statusFor } from './responsibility'
import type { CalendarLink, GoogleAccount, Task } from './types'

export const SYNC_WINDOW_DAYS = 30 // これより古いタスクは新規には同期しない（API 呼び出し削減）
export const MAX_AUTO_RETRY = 5
export const MAX_OPS_PER_RUN = 200

// ---------- エラー分類 ----------
export type GoogleErrorKind = 'auth' | 'rate_limit' | 'calendar_missing' | 'not_found' | 'conflict' | 'network' | 'other'
export class GoogleError extends Error {
  kind: GoogleErrorKind
  status: number
  constructor(kind: GoogleErrorKind, status: number, message: string) {
    super(message)
    this.kind = kind
    this.status = status
  }
}

/** 利用者向けの日本語メッセージ（次に何をすればよいか） */
export function friendlyError(e: unknown): string {
  if (e instanceof GoogleError) {
    switch (e.kind) {
      case 'auth': return 'Googleとの接続が切れました。「Googleに再接続」を押してください。'
      case 'rate_limit': return 'Googleの利用制限に達しました。しばらく（1時間ほど）待ってから「今すぐ同期」を押してください。'
      case 'calendar_missing': return 'Google側の「NAORU TASK」カレンダーが見つかりません。「今すぐ同期」を押すと作り直します。'
      case 'network': return '通信できませんでした。電波の良い場所で「今すぐ同期」を押してください。'
      default: return 'Googleカレンダーへの反映に失敗しました。時間をおいて「今すぐ同期」を押してください。続く場合は管理者に連絡してください。'
    }
  }
  return (e as Error)?.message || '不明なエラーが発生しました。'
}

// ---------- 依存（本番は calendar.ts / supabaseRepo、テストはモック） ----------
export interface CalendarApi {
  createCalendar(): Promise<string>
  calendarExists(calendarId: string): Promise<boolean>
  /** 予定を作成または更新（同じ eventId なら上書き。削除済みでも復活させる） */
  upsertEvent(calendarId: string, eventId: string, body: EventBody): Promise<void>
  /** 予定を削除（既に無い場合も成功扱い） */
  deleteEvent(calendarId: string, eventId: string): Promise<void>
  deleteCalendar(calendarId: string): Promise<void>
  /** 専用カレンダー内で updatedMin 以降に更新された予定（Google側での完了操作の検出用） */
  listChangedEvents(calendarId: string, updatedMin: string | null, timeMin: string): Promise<RemoteEvent[]>
}

export interface RemoteEvent {
  id: string
  summary: string
  colorId: string | null
  taskId: string | null
}

export interface SyncStore {
  getAccount(): Promise<GoogleAccount | null>
  /** calendar_id が未設定の時だけ設定し、最終的に有効な calendar_id を返す（端末間の競合対策） */
  claimCalendar(calendarId: string): Promise<string>
  resetCalendar(): Promise<void>
  updateAccount(patch: Partial<GoogleAccount>): Promise<void>
  listLinks(): Promise<CalendarLink[]>
  saveLink(link: CalendarLink): Promise<void>
  deleteLink(taskId: string): Promise<void>
  /** 削除済みも含めて ID でタスクを取得（読み込み範囲外・他店舗のリンク解決用） */
  fetchTasks(ids: string[]): Promise<Task[]>
  /** 本人として完了にする（全員向けタスクは本人の分） */
  completeTask(task: Task): Promise<Task>
}

// ---------- 予定の内容 ----------
export interface EventBody {
  summary: string
  description: string
  // 終日⇔時間指定を切り替えたとき古い方が残らないよう、使わない側は必ず null を送る（PATCH は項目単位で上書きのため）
  start: { date: string | null; dateTime: string | null; timeZone: string | null }
  end: { date: string | null; dateTime: string | null; timeZone: string | null }
  colorId: string | null
  transparency: 'transparent' | 'opaque'
  status: 'confirmed'
  extendedProperties: { private: { naoruTaskId: string } }
}

/** タスク ID → Google の予定 ID（英小文字 a-v と数字のみ可。UUID の16進はそのまま使える） */
export const eventIdFor = (taskId: string) => 'naoru' + taskId.replace(/-/g, '').toLowerCase()

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

/**
 * 表示ルール
 * - 作業時間あり : 作業日のその時間帯に予定（締切は説明欄と件名に併記）
 * - 締切時刻あり : 期限日の終日予定「⏰18:00締切」（時間帯をふさがない）
 * - 日付のみ     : 期限日の終日予定
 * - 完了         : 件名先頭に「✅ 完了」、緑色
 * - 優先度 高    : 件名先頭に「‼」、赤色
 * - 小項目       : 別の予定にはせず、親タスクの予定の説明欄に ☑/☐ で一覧表示
 */
export function buildEvent(t: Task, uid: string, children: Task[] = [], tz = 'Asia/Tokyo'): EventBody {
  const done = statusFor(t, uid) === 'done'
  const parts: string[] = []
  if (done) parts.push('✅ 完了')
  else if (t.priority === 'high') parts.push('‼')
  const hasWork = !!(t.work_date && t.work_start && t.work_end)
  if (t.due_date && t.due_time) parts.push(`⏰${hasWork && t.work_date !== t.due_date ? md(t.due_date) + ' ' : ''}${t.due_time}締切`)
  else if (hasWork && t.due_date && t.due_date !== t.work_date) parts.push(`⏰${md(t.due_date)}締切`)
  parts.push(t.title)

  const lines = ['NAORU TASK で管理しているタスクです。内容の変更はアプリで行ってください。',
    '完了にするには: アプリでチェック、またはこの予定の色を「バジル（緑）」に変更／件名の先頭に「✅」か「完了」を付ける']
  if (t.due_date) lines.push(`期限: ${md(t.due_date)}${t.due_time ? ' ' + t.due_time : ''}`)
  if (hasWork) lines.push(`作業: ${md(t.work_date!)} ${t.work_start}〜${t.work_end}`)
  if (t.assignment_mode === 'everyone') lines.push('全員が各自実施するタスク')
  const kids = children.filter((c) => !c.deleted_at)
  if (kids.length) {
    const doneCount = kids.filter((c) => c.status === 'done').length
    lines.push('', `小項目（${doneCount}/${kids.length} 完了）`)
    for (const c of kids) lines.push(`${c.status === 'done' ? '☑' : '☐'} ${c.title}${c.due_date ? `（${md(c.due_date)}）` : ''}`)
  }

  const base = {
    summary: parts.join(' '),
    description: lines.join('\n'),
    colorId: done ? '10' : t.priority === 'high' ? '11' : null,
    status: 'confirmed' as const,
    extendedProperties: { private: { naoruTaskId: t.id } },
  }
  if (hasWork) {
    return {
      ...base,
      start: { date: null, dateTime: `${t.work_date}T${t.work_start}:00`, timeZone: tz },
      end: { date: null, dateTime: `${t.work_date}T${t.work_end}:00`, timeZone: tz },
      transparency: 'opaque',
    }
  }
  const day = t.due_date ?? t.work_date!
  return { ...base, start: { date: day, dateTime: null, timeZone: null }, end: { date: addDays(day, 1), dateTime: null, timeZone: null }, transparency: 'transparent' }
}

export const hashEvent = (calendarId: string, b: EventBody) => JSON.stringify([calendarId, b])

/** 本人のカレンダーにあるべきタスクか（小項目は親の予定にまとめるので単独では同期しない） */
export function shouldSync(t: Task, uid: string): boolean {
  return !t.deleted_at && !t.parent_id && isAssignedTo(t, uid) && !!(t.due_date || (t.work_date && t.work_start))
}

const sortChildren = (a: Task, b: Task) =>
  (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.created_at.localeCompare(b.created_at)

// ---------- 同期計画 ----------
export type SyncOp =
  | { type: 'upsert'; task: Task; link: CalendarLink | undefined; body: EventBody; hash: string }
  | { type: 'delete'; link: CalendarLink }

export function planSync(opts: {
  uid: string
  calendarId: string | null
  tasks: Task[]
  links: CalendarLink[]
  today: string
  force?: boolean
}): { ops: SyncOp[]; waitingRetry: number } {
  const { uid, calendarId, tasks, links, today } = opts
  const linkMap = new Map(links.map((l) => [l.task_id, l]))
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const floor = addDays(today, -SYNC_WINDOW_DAYS)
  const childrenOf = new Map<string, Task[]>()
  for (const t of tasks) if (t.parent_id) childrenOf.set(t.parent_id, [...(childrenOf.get(t.parent_id) ?? []), t])
  const ops: SyncOp[] = []
  let waitingRetry = 0

  for (const t of tasks) {
    if (!shouldSync(t, uid)) continue
    const link = linkMap.get(t.id)
    const day = t.work_date && t.work_start ? t.work_date : t.due_date!
    if (!link && day < floor) continue // 古いタスクは新規作成しない
    const body = buildEvent(t, uid, (childrenOf.get(t.id) ?? []).sort(sortChildren))
    const hash = hashEvent(calendarId ?? '', body)
    const upToDate = link && link.calendar_id === calendarId && link.sync_status === 'synced' && link.synced_hash === hash
    if (upToDate) continue
    if (link && link.sync_status === 'error' && link.retry_count >= MAX_AUTO_RETRY && !opts.force) { waitingRetry++; continue }
    ops.push({ type: 'upsert', task: t, link, body, hash })
  }
  for (const l of links) {
    const t = taskMap.get(l.task_id)
    if (t && shouldSync(t, uid)) continue
    if (!t) continue // 未取得のタスクは呼び出し側で fetchTasks してから判定する
    ops.push({ type: 'delete', link: l })
  }
  return { ops, waitingRetry }
}

export interface SyncResult {
  synced: number
  deleted: number
  failed: number
  waitingRetry: number
  /** Googleカレンダー側の操作で完了にしたタスク数 */
  completedFromGoogle: number
  stopped: GoogleErrorKind | null
  message: string | null
}

const now = () => new Date().toISOString()

/** 専用カレンダーを用意（端末間で共有。消されていたら作り直す） */
export async function ensureCalendar(api: CalendarApi, store: SyncStore, account: GoogleAccount, verify: boolean): Promise<string> {
  if (account.calendar_id) {
    if (!verify || (await api.calendarExists(account.calendar_id))) return account.calendar_id
    await store.resetCalendar()
  }
  const created = await api.createCalendar()
  const winner = await store.claimCalendar(created)
  if (winner !== created) await api.deleteCalendar(created).catch(() => {}) // 他端末が先に作成済み
  return winner
}

/** 同期を1回実行。Google のエラーでもタスク管理には影響しない（呼び出し側で例外を握る必要なし） */
export async function runSync(opts: {
  uid: string
  storeId: string
  api: CalendarApi
  store: SyncStore
  tasks: Task[]
  today: string
  verifyCalendar?: boolean
  force?: boolean
  onProgress?: (done: number, total: number) => void
}): Promise<SyncResult> {
  const { uid, api, store } = opts
  const res: SyncResult = { synced: 0, deleted: 0, failed: 0, waitingRetry: 0, completedFromGoogle: 0, stopped: null, message: null }
  const account = await store.getAccount()
  if (!account || account.status === 'disconnected') return { ...res, message: 'Googleカレンダーが未連携です。' }

  let calendarId: string
  try {
    calendarId = await ensureCalendar(api, store, account, opts.verifyCalendar ?? false)
  } catch (e) {
    return finish(e)
  }

  const links = await store.listLinks()
  // 読み込み範囲外のタスク（古い・削除済み・他店舗）の対応表は ID で取り直して判定
  const known = new Set(opts.tasks.map((t) => t.id))
  const missing = links.filter((l) => !known.has(l.task_id)).map((l) => l.task_id)
  const extra = missing.length ? await store.fetchTasks(missing) : []
  let all = [...opts.tasks, ...extra]

  // Google側で「完了」にされた予定を検出してアプリでも完了にする（NAORU TASK の予定のみ）
  if (account.last_sync_at) {
    try {
      const done = await detectGoogleCompletions(api, calendarId, account.last_sync_at, opts.today, links, all, uid)
      for (const t of done) {
        try {
          const updated = await store.completeTask(t)
          all = all.map((x) => (x.id === updated.id ? updated : x))
          res.completedFromGoogle++
        } catch { /* 権限なし等は無視（アプリ側の状態を優先） */ }
      }
    } catch (e) {
      if (isFatal(e)) return finish(e)
      // 読み取りに失敗しても、アプリ→Googleの反映は続行
    }
  }
  const fetched = new Set(all.map((t) => t.id))
  const { ops, waitingRetry } = planSync({ uid, calendarId, tasks: all, links, today: opts.today, force: opts.force })
  // DB からも消えたタスク（物理削除）の予定も削除対象
  for (const l of links) if (!fetched.has(l.task_id)) ops.push({ type: 'delete', link: l })
  res.waitingRetry = waitingRetry

  const batch = ops.slice(0, MAX_OPS_PER_RUN)
  let i = 0
  for (const op of batch) {
    opts.onProgress?.(i++, batch.length)
    if (op.type === 'delete') {
      try {
        // 対応表に予定 ID が無くても、決定的 ID で作成済みの可能性があるため削除を試みる
        await api.deleteEvent(op.link.calendar_id, op.link.google_event_id ?? eventIdFor(op.link.task_id))
        await store.deleteLink(op.link.task_id)
        res.deleted++
      } catch (e) {
        if (e instanceof GoogleError && (e.kind === 'calendar_missing' || e.kind === 'not_found')) {
          await store.deleteLink(op.link.task_id) // カレンダーごと消えている → 予定も無い
          res.deleted++
          continue
        }
        res.failed++
        await store.saveLink({ ...op.link, sync_status: kindToStatus(e), last_error: friendlyError(e), retry_count: op.link.retry_count + 1 })
        if (isFatal(e)) return finish(e)
      }
      continue
    }
    const eventId = eventIdFor(op.task.id)
    const base: CalendarLink = op.link && op.link.calendar_id === calendarId
      ? op.link
      : { task_id: op.task.id, user_id: uid, store_id: op.task.store_id, calendar_id: calendarId, google_event_id: null, sync_status: 'pending', synced_hash: null, last_error: null, retry_count: 0, synced_at: null }
    try {
      if (op.link) await store.saveLink({ ...base, sync_status: 'syncing' })
      // カレンダーが作り直された場合、古いカレンダー上の予定は削除を試みる
      if (op.link && op.link.calendar_id !== calendarId && op.link.google_event_id) {
        await api.deleteEvent(op.link.calendar_id, op.link.google_event_id).catch(() => {})
      }
      await api.upsertEvent(calendarId, eventId, op.body)
      await store.saveLink({ ...base, calendar_id: calendarId, google_event_id: eventId, sync_status: 'synced', synced_hash: op.hash, last_error: null, retry_count: 0, synced_at: now() })
      res.synced++
    } catch (e) {
      res.failed++
      await store.saveLink({ ...base, google_event_id: base.google_event_id, sync_status: kindToStatus(e), last_error: friendlyError(e), retry_count: base.retry_count + 1 })
      if (e instanceof GoogleError && e.kind === 'calendar_missing') await store.resetCalendar()
      if (isFatal(e)) return finish(e)
    }
  }
  if (ops.length > batch.length) res.message = `残り${ops.length - batch.length}件は次回の同期で反映します。`
  return finish(null)

  async function finish(e: unknown): Promise<SyncResult> {
    if (e) {
      res.stopped = e instanceof GoogleError ? e.kind : 'other'
      res.message = friendlyError(e)
    }
    await store.updateAccount({
      status: res.stopped === 'auth' ? 'reauth_required' : 'active',
      last_sync_at: now(),
      last_success_count: res.synced + res.deleted,
      last_failure_count: res.failed + (e && !res.failed ? 1 : 0),
      last_error: res.message && e ? res.message : null,
    }).catch(() => {})
    return res
  }
}

/** Google側で人が行った完了操作か: 色を緑(バジル=10)にした / 件名の先頭に ✅・☑・✔・完了 を付けた */
export function isDoneMarker(ev: Pick<RemoteEvent, 'summary' | 'colorId'>) {
  return ev.colorId === '10' || /^\s*(✅|☑|✔|完了)/.test(ev.summary)
}

/**
 * 完了にすべきタスクを特定。アプリ自身が最後に書き込んだ内容（synced_hash）と比べて
 * 件名か色が「人の手で」変わっていて、かつ完了の目印がある場合だけ対象にする。
 * （アプリで完了→元に戻した直後に、Google上に残っている古い ✅ を誤って拾わないため）
 */
export async function detectGoogleCompletions(api: CalendarApi, calendarId: string, lastSyncAt: string, today: string,
  links: CalendarLink[], tasks: Task[], uid: string): Promise<Task[]> {
  const since = new Date(new Date(lastSyncAt).getTime() - 5 * 60_000).toISOString() // 時計のずれを考慮
  const timeMin = `${addDays(today, -SYNC_WINDOW_DAYS)}T00:00:00+09:00`
  const events = await api.listChangedEvents(calendarId, since, timeMin)
  const linkMap = new Map(links.map((l) => [l.task_id, l]))
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const out: Task[] = []
  for (const ev of events) {
    if (!ev.taskId) continue
    const link = linkMap.get(ev.taskId)
    const t = taskMap.get(ev.taskId)
    if (!link?.synced_hash || link.calendar_id !== calendarId || !t || t.deleted_at) continue
    if (!isAssignedTo(t, uid) || statusFor(t, uid) === 'done') continue
    let written: EventBody
    try { written = JSON.parse(link.synced_hash)[1] as EventBody } catch { continue }
    const changedByUser = ev.summary !== written.summary || (ev.colorId ?? null) !== (written.colorId ?? null)
    if (changedByUser && isDoneMarker(ev)) out.push(t)
  }
  return out
}

function kindToStatus(e: unknown): CalendarLink['sync_status'] {
  return e instanceof GoogleError && e.kind === 'auth' ? 'reauth_required' : 'error'
}
/** これ以上続けても失敗するエラーはその回の同期を中断（無駄な API 呼び出しをしない） */
function isFatal(e: unknown) {
  return e instanceof GoogleError && ['auth', 'rate_limit', 'network', 'calendar_missing'].includes(e.kind)
}

/** トークン不要で数えられる「未反映」件数（ホームのお知らせ用） */
export function countPending(uid: string, calendarId: string | null, tasks: Task[], links: CalendarLink[], today: string) {
  const { ops } = planSync({ uid, calendarId, tasks, links, today })
  const known = new Set(tasks.map((t) => t.id))
  // 読み込み範囲外のリンクで pending のもの（他人が削除・担当変更した等）
  const outside = links.filter((l) => !known.has(l.task_id) && l.sync_status !== 'synced').length
  return ops.length + outside
}
