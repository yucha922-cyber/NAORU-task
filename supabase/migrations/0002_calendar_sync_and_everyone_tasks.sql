-- 0002: Googleカレンダー同期の強化 / 全員向けタスク / 作業時間
-- 既存データは削除・変換しない（追加のみ）。0001 適用済みのDBに対して実行する。
-- 再実行しても安全（冪等）。

-- ========== tasks / task_templates: 割当方式・作業時間 ==========
-- single  : 担当者1人（または未割当＝誰か1人が実施すれば完了）。既存タスクはすべてこれ
-- everyone: 全員が実施（スタッフごとに完了状態を持つ）
alter table public.tasks add column if not exists assignment_mode text not null default 'single';
alter table public.tasks add column if not exists work_date date;
alter table public.tasks add column if not exists work_start time;
alter table public.tasks add column if not exists work_end time;
alter table public.task_templates add column if not exists assignment_mode text not null default 'single';

do $$ begin
  alter table public.tasks add constraint tasks_assignment_mode_check
    check (assignment_mode in ('single', 'everyone'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.tasks add constraint tasks_everyone_no_assignee
    check (assignment_mode = 'single' or assignee_id is null);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.tasks add constraint tasks_work_time_check check (
    (work_start is null) = (work_end is null)
    and (work_start is null or (work_date is not null and work_end > work_start))
  );
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.task_templates add constraint task_templates_assignment_mode_check
    check (assignment_mode in ('single', 'everyone') and (assignment_mode = 'single' or assignee_id is null));
exception when duplicate_object then null; end $$;

-- ========== 全員向けタスクのスタッフ別完了状態 ==========
create table if not exists public.task_assignees (
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'done')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id),
  check ((status = 'done') = (completed_at is not null))
);
create index if not exists task_assignees_user_idx on public.task_assignees (user_id, status);
create index if not exists task_assignees_store_idx on public.task_assignees (store_id);

-- 全員向けタスク作成時（または single→everyone 変更時）に、店舗の有効メンバー全員分の行を作成
create or replace function public.tasks_sync_assignees()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assignment_mode = 'everyone' and (tg_op = 'INSERT' or old.assignment_mode <> 'everyone') then
    insert into public.task_assignees (task_id, user_id, store_id)
    select new.id, m.user_id, new.store_id from public.memberships m
    where m.store_id = new.store_id and m.active
    on conflict do nothing;
  elsif tg_op = 'UPDATE' and new.assignment_mode = 'single' and old.assignment_mode = 'everyone' then
    delete from public.task_assignees where task_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists tasks_sync_assignees on public.tasks;
create trigger tasks_sync_assignees after insert or update of assignment_mode on public.tasks
  for each row execute function public.tasks_sync_assignees();

-- 個人の完了操作: 変更できるのは status のみ。完了日時を自動設定
create or replace function public.task_assignees_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    select store_id into new.store_id from public.tasks where id = new.task_id;
  else
    new.task_id := old.task_id; new.user_id := old.user_id; new.store_id := old.store_id; new.created_at := old.created_at;
  end if;
  if new.status = 'done' then
    new.completed_at := coalesce(case when tg_op = 'UPDATE' and old.status = 'done' then old.completed_at end, now());
  else
    new.completed_at := null;
  end if;
  return new;
end $$;
drop trigger if exists task_assignees_before_write on public.task_assignees;
create trigger task_assignees_before_write before insert or update on public.task_assignees
  for each row execute function public.task_assignees_before_write();

-- 全員完了したら親タスクを完了に／誰かが戻したら未完了に。操作履歴も記録
create or replace function public.task_assignees_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_open int; v_task record;
begin
  select * into v_task from public.tasks where id = new.task_id;
  if v_task is null then return new; end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into public.task_activity (store_id, task_id, task_title, actor_id, action, changes)
    values (v_task.store_id, v_task.id, v_task.title, auth.uid(),
            case when new.status = 'done' then 'complete' else 'reopen' end,
            jsonb_build_object('assignee', new.user_id));
  end if;
  select count(*) into v_open from public.task_assignees where task_id = new.task_id and status = 'open';
  if v_open = 0 and v_task.status = 'open' then
    update public.tasks set status = 'done' where id = new.task_id;
  elsif v_open > 0 and v_task.status = 'done' then
    update public.tasks set status = 'open' where id = new.task_id;
  end if;
  return new;
end $$;
drop trigger if exists task_assignees_after_write on public.task_assignees;
create trigger task_assignees_after_write after insert or update on public.task_assignees
  for each row execute function public.task_assignees_after_write();

alter table public.task_assignees enable row level security;
drop policy if exists task_assignees_select on public.task_assignees;
create policy task_assignees_select on public.task_assignees for select to authenticated
  using (public.is_member(store_id));
-- 自分の完了状態だけ変更可（院長・管理者は全員分）
drop policy if exists task_assignees_update on public.task_assignees;
create policy task_assignees_update on public.task_assignees for update to authenticated
  using (public.is_member(store_id) and (user_id = auth.uid() or public.is_manager(store_id)))
  with check (public.is_member(store_id) and (user_id = auth.uid() or public.is_manager(store_id)));
drop policy if exists task_assignees_insert on public.task_assignees;
create policy task_assignees_insert on public.task_assignees for insert to authenticated
  with check (public.is_manager(store_id));
drop policy if exists task_assignees_delete on public.task_assignees;
create policy task_assignees_delete on public.task_assignees for delete to authenticated
  using (public.is_manager(store_id));

-- ========== Googleカレンダー: アカウント（ユーザーごとの専用カレンダー） ==========
-- calendar_id を端末ではなくDBで管理 → スマホとPCで同じ「NAORU TASK」カレンダーを共有（重複作成しない）
-- アクセストークンは保存しない（ブラウザのメモリ上のみ）
create table if not exists public.google_calendar_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  google_email text,
  calendar_id text,
  status text not null default 'active' check (status in ('active', 'reauth_required', 'disconnected')),
  last_sync_at timestamptz,
  last_success_count int not null default 0,
  last_failure_count int not null default 0,
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.google_calendar_accounts enable row level security;
drop policy if exists gcal_accounts_own on public.google_calendar_accounts;
create policy gcal_accounts_own on public.google_calendar_accounts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ========== task_calendar_links: 同期状態の拡張 ==========
-- タスクを物理削除しても対応表を残し、次回同期で Google 側の予定を確実に削除するため FK を外す
alter table public.task_calendar_links drop constraint if exists task_calendar_links_task_id_fkey;
alter table public.task_calendar_links drop constraint if exists task_calendar_links_sync_status_check;
alter table public.task_calendar_links add constraint task_calendar_links_sync_status_check
  check (sync_status in ('pending', 'syncing', 'synced', 'error', 'reauth_required'));
alter table public.task_calendar_links add column if not exists updated_at timestamptz not null default now();

-- タスク側の変更を「未同期」として記録（他人が変更しても本人の次回起動時に検出できる）
create or replace function public.mark_calendar_links_pending()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'tasks' then
    if tg_op = 'DELETE' then
      update public.task_calendar_links set sync_status = 'pending', updated_at = now() where task_id = old.id;
      return old;
    end if;
    if (new.title, new.due_date, new.due_time, new.work_date, new.work_start, new.work_end, new.status,
        new.priority, new.assignee_id, new.deleted_at, new.assignment_mode)
       is distinct from
       (old.title, old.due_date, old.due_time, old.work_date, old.work_start, old.work_end, old.status,
        old.priority, old.assignee_id, old.deleted_at, old.assignment_mode) then
      update public.task_calendar_links set sync_status = 'pending', updated_at = now()
      where task_id = new.id and sync_status <> 'pending';
    end if;
    return new;
  else -- task_assignees
    if tg_op = 'DELETE' then
      update public.task_calendar_links set sync_status = 'pending', updated_at = now()
      where task_id = old.task_id and user_id = old.user_id;
      return old;
    end if;
    update public.task_calendar_links set sync_status = 'pending', updated_at = now()
    where task_id = new.task_id and user_id = new.user_id and sync_status <> 'pending';
    return new;
  end if;
end $$;
drop trigger if exists tasks_mark_links_pending on public.tasks;
create trigger tasks_mark_links_pending after update or delete on public.tasks
  for each row execute function public.mark_calendar_links_pending();
drop trigger if exists task_assignees_mark_links_pending on public.task_assignees;
create trigger task_assignees_mark_links_pending after update or delete on public.task_assignees
  for each row execute function public.mark_calendar_links_pending();

-- ========== 繰り返し生成: 割当方式を引き継ぐ ==========
create or replace function public.generate_recurring_tasks(p_store uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_tz text; v_today date; v_until date; v_from date; v_d date;
  v_count int := 0; v_n int; t record; v_occurs boolean; v_last int;
begin
  if auth.uid() is not null and not public.is_member(p_store) then raise exception '権限がありません'; end if;
  perform pg_advisory_xact_lock(hashtext('gen:' || p_store::text));
  select timezone into v_tz from public.stores where id = p_store;
  if v_tz is null then return 0; end if;
  v_today := (now() at time zone v_tz)::date;
  v_until := v_today + 1;
  for t in select * from public.task_templates where store_id = p_store and active loop
    v_from := greatest(coalesce(t.last_generated_date + 1, t.start_date), v_today - 7, t.start_date);
    v_d := v_from;
    while v_d <= v_until and (t.end_date is null or v_d <= t.end_date) loop
      v_last := extract(day from (date_trunc('month', v_d) + interval '1 month - 1 day'))::int;
      v_occurs := case t.frequency
        when 'daily' then true
        when 'weekly' then extract(dow from v_d)::int = any (t.weekdays)
        when 'interval' then ((v_d - t.start_date) % greatest(t.interval_days, 1)) = 0
        when 'monthly' then extract(day from v_d)::int = least(t.day_of_month, v_last)
        else false end;
      if v_occurs then
        insert into public.tasks (store_id, title, description, assignee_id, priority, category,
                                  due_date, due_time, template_id, occurrence_date, created_by, assignment_mode)
        values (t.store_id, t.title, t.description, case when t.assignment_mode = 'everyone' then null else t.assignee_id end,
                t.priority, t.category, v_d, t.due_time, t.id, v_d, t.created_by, t.assignment_mode)
        on conflict (template_id, occurrence_date) where template_id is not null do nothing;
        get diagnostics v_n = row_count;
        v_count := v_count + v_n;
      end if;
      v_d := v_d + 1;
    end loop;
    update public.task_templates set last_generated_date = greatest(coalesce(last_generated_date, v_until), v_until)
    where id = t.id;
  end loop;
  return v_count;
end $$;
revoke execute on function public.generate_recurring_tasks(uuid) from public, anon;
grant execute on function public.generate_recurring_tasks(uuid) to authenticated;

-- ========== 権限 ==========
grant select, insert, update, delete on public.task_assignees, public.google_calendar_accounts to authenticated;
revoke all on public.task_assignees, public.google_calendar_accounts from anon;
