-- NAORU TASK 初期スキーマ（Supabase Free 用）
-- 医療情報（患者氏名・症状など）は保存しない。業務の完了状態のみ管理する。
-- 実行方法: Supabase ダッシュボード > SQL Editor に貼り付けて実行

create extension if not exists pgcrypto;

-- ========== 型 ==========
do $$ begin
  create type public.member_role as enum ('staff', 'manager', 'admin');
exception when duplicate_object then null; end $$;

-- ========== テーブル ==========
create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  timezone text not null default 'Asia/Tokyo',
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null default '' check (char_length(display_name) <= 50),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_email_key on public.profiles (lower(email));

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.member_role not null default 'staff',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, user_id)
);
create index if not exists memberships_user_idx on public.memberships (user_id);

create table if not exists public.task_templates (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  assignee_id uuid references public.profiles (id) on delete set null,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  category text not null default 'general'
    check (category in ('general', 'daily_report', 'karte', 'cleaning', 'blog', 'report')),
  frequency text not null check (frequency in ('daily', 'weekly', 'interval', 'monthly')),
  interval_days int check (interval_days between 1 and 365),
  weekdays int[] not null default '{}',
  day_of_month int check (day_of_month between 1 and 31),
  due_time time,
  start_date date not null,
  end_date date,
  last_generated_date date,
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (frequency <> 'interval' or interval_days is not null),
  check (frequency <> 'monthly' or day_of_month is not null),
  check (frequency <> 'weekly' or cardinality(weekdays) > 0),
  check (weekdays <@ array[0, 1, 2, 3, 4, 5, 6]),
  check (end_date is null or end_date >= start_date)
);
create index if not exists task_templates_store_idx on public.task_templates (store_id) where active;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  parent_id uuid references public.tasks (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  assignee_id uuid references public.profiles (id) on delete set null,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  category text not null default 'general'
    check (category in ('general', 'daily_report', 'karte', 'cleaning', 'blog', 'report')),
  due_date date,
  due_time time,
  status text not null default 'open' check (status in ('open', 'done')),
  completed_at timestamptz,
  completed_by uuid references public.profiles (id) on delete set null,
  template_id uuid references public.task_templates (id) on delete set null,
  occurrence_date date,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (parent_id is null or parent_id <> id),
  check ((status = 'done') = (completed_at is not null))
);
-- 繰り返しタスクの二重生成防止
create unique index if not exists tasks_template_occurrence_key
  on public.tasks (template_id, occurrence_date) where template_id is not null;
create index if not exists tasks_store_open_idx on public.tasks (store_id, due_date) where status = 'open' and deleted_at is null;
create index if not exists tasks_store_done_idx on public.tasks (store_id, completed_at desc) where status = 'done' and deleted_at is null;
create index if not exists tasks_assignee_idx on public.tasks (assignee_id, status) where deleted_at is null;
create index if not exists tasks_parent_idx on public.tasks (parent_id) where parent_id is not null;

create table if not exists public.task_activity (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores (id) on delete cascade,
  task_id uuid not null, -- タスク物理削除後も履歴を残すため FK は張らない
  task_title text not null,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (action in ('create', 'update', 'complete', 'reopen', 'delete')),
  changes jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists task_activity_store_idx on public.task_activity (store_id, created_at desc);
create index if not exists task_activity_task_idx on public.task_activity (task_id);

create table if not exists public.task_calendar_links (
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  calendar_id text not null,
  google_event_id text,
  sync_status text not null default 'pending' check (sync_status in ('synced', 'pending', 'error')),
  synced_hash text,
  last_error text,
  retry_count int not null default 0,
  synced_at timestamptz,
  primary key (task_id, user_id)
);
create index if not exists task_calendar_links_user_idx on public.task_calendar_links (user_id, sync_status);

-- ========== 権限ヘルパー（RLS の再帰を避けるため security definer） ==========
create or replace function public.my_role(p_store uuid)
returns public.member_role language sql stable security definer set search_path = public as $$
  select role from public.memberships
  where store_id = p_store and user_id = auth.uid() and active
$$;

create or replace function public.is_member(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.my_role(p_store) is not null
$$;

create or replace function public.is_manager(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role(p_store) in ('manager', 'admin'), false)
$$;

create or replace function public.shares_store(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships a join public.memberships b on a.store_id = b.store_id
    where a.user_id = auth.uid() and a.active and b.user_id = p_user
  )
$$;

-- ========== トリガー ==========
-- 新規ユーザー登録時にプロフィールを作成
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- タスクの整合性: 2階層まで / 親と同じ店舗 / store_id・作成者の改ざん防止 / 完了日時
create or replace function public.tasks_before_write()
returns trigger language plpgsql set search_path = public as $$
declare p record;
begin
  if tg_op = 'UPDATE' then
    if new.store_id <> old.store_id then raise exception '店舗は変更できません'; end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.template_id := old.template_id;
    new.occurrence_date := old.occurrence_date;
    new.updated_at := now();
  end if;
  if new.parent_id is not null then
    select store_id, parent_id into p from public.tasks where id = new.parent_id;
    if p is null then raise exception '親タスクが見つかりません'; end if;
    if p.store_id <> new.store_id then raise exception '親タスクは同じ店舗である必要があります'; end if;
    if p.parent_id is not null then raise exception '親子タスクは2階層までです'; end if;
    if exists (select 1 from public.tasks where parent_id = new.id) then
      raise exception '子タスクを持つタスクは小項目にできません';
    end if;
  end if;
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.completed_at := now();
    new.completed_by := auth.uid();
  elsif new.status = 'open' then
    new.completed_at := null;
    new.completed_by := null;
  elsif tg_op = 'UPDATE' then
    new.completed_at := old.completed_at;
    new.completed_by := old.completed_by;
  end if;
  return new;
end $$;
drop trigger if exists tasks_before_write on public.tasks;
create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

-- 操作履歴（クライアントから直接書けないよう、トリガーのみで記録）
create or replace function public.tasks_log_activity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_action text;
  v_changes jsonb := '{}';
  k text;
begin
  if tg_op = 'INSERT' then
    v_action := 'create';
  elsif tg_op = 'DELETE' then
    insert into public.task_activity (store_id, task_id, task_title, actor_id, action)
    values (old.store_id, old.id, old.title, auth.uid(), 'delete');
    return old;
  elsif new.deleted_at is not null and old.deleted_at is null then
    v_action := 'delete';
  elsif new.status = 'done' and old.status = 'open' then
    v_action := 'complete';
  elsif new.status = 'open' and old.status = 'done' then
    v_action := 'reopen';
  else
    v_action := 'update';
    foreach k in array array['title', 'description', 'assignee_id', 'priority', 'category', 'due_date', 'due_time', 'parent_id'] loop
      if to_jsonb(new) -> k is distinct from to_jsonb(old) -> k then
        v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('from', to_jsonb(old) -> k, 'to', to_jsonb(new) -> k));
      end if;
    end loop;
    if v_changes = '{}' then return new; end if;
  end if;
  insert into public.task_activity (store_id, task_id, task_title, actor_id, action, changes)
  values (new.store_id, new.id, new.title, auth.uid(), v_action, v_changes);
  return new;
end $$;
drop trigger if exists tasks_log_activity on public.tasks;
create trigger tasks_log_activity after insert or update or delete on public.tasks
  for each row execute function public.tasks_log_activity();

-- ========== RLS ==========
alter table public.stores enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.tasks enable row level security;
alter table public.task_templates enable row level security;
alter table public.task_activity enable row level security;
alter table public.task_calendar_links enable row level security;

drop policy if exists stores_select on public.stores;
create policy stores_select on public.stores for select to authenticated using (public.is_member(id));
drop policy if exists stores_update on public.stores;
create policy stores_update on public.stores for update to authenticated
  using (public.my_role(id) = 'admin') with check (public.my_role(id) = 'admin');
-- 店舗作成は create_store() 関数経由のみ

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_store(id));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = auth.uid() or public.is_member(store_id));
drop policy if exists memberships_update on public.memberships;
create policy memberships_update on public.memberships for update to authenticated
  using (public.my_role(store_id) = 'admin' and user_id <> auth.uid())
  with check (public.my_role(store_id) = 'admin');
-- 追加は add_member_by_email() 関数経由のみ。物理削除は不可（active=false で無効化）

-- タスク: 同じ店舗のメンバーは閲覧可。編集は担当者・作成者・院長/管理者
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (public.is_member(store_id));
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check (
    public.is_member(store_id) and created_by = auth.uid() and template_id is null
    and (assignee_id is null or assignee_id = auth.uid() or public.is_manager(store_id))
  );
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_member(store_id) and (public.is_manager(store_id) or assignee_id = auth.uid() or assignee_id is null or created_by = auth.uid()))
  with check (public.is_member(store_id) and (public.is_manager(store_id) or assignee_id = auth.uid() or assignee_id is null));
-- 物理削除は管理者のみ（通常は deleted_at による論理削除）
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.my_role(store_id) = 'admin');

drop policy if exists templates_select on public.task_templates;
create policy templates_select on public.task_templates for select to authenticated
  using (public.is_member(store_id));
drop policy if exists templates_write on public.task_templates;
create policy templates_write on public.task_templates for all to authenticated
  using (public.is_manager(store_id)) with check (public.is_manager(store_id));

drop policy if exists activity_select on public.task_activity;
create policy activity_select on public.task_activity for select to authenticated
  using (public.is_member(store_id));
-- insert/update/delete ポリシーなし = クライアントからは改ざん不可

drop policy if exists calendar_links_own on public.task_calendar_links;
create policy calendar_links_own on public.task_calendar_links for all to authenticated
  using (user_id = auth.uid() and public.is_member(store_id))
  with check (user_id = auth.uid() and public.is_member(store_id));

-- ========== RPC ==========
-- 店舗作成（作成者が管理者になる）
create or replace function public.create_store(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  -- 乱用防止: 1ユーザーが作れる店舗は 5 まで
  if (select count(*) from public.memberships where user_id = auth.uid() and role = 'admin') >= 5 then
    raise exception '作成できる店舗数の上限に達しました';
  end if;
  insert into public.stores (name) values (p_name) returning id into v_id;
  insert into public.memberships (store_id, user_id, role) values (v_id, auth.uid(), 'admin');
  return v_id;
end $$;

-- メンバー追加（相手が一度ログイン/登録済みであること）
create or replace function public.add_member_by_email(p_store uuid, p_email text, p_role public.member_role)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_id uuid;
begin
  if public.my_role(p_store) is distinct from 'admin' then raise exception '権限がありません'; end if;
  select id into v_user from public.profiles where lower(email) = lower(trim(p_email));
  if v_user is null then raise exception 'このメールアドレスのユーザーが未登録です。先に本人がアカウント登録してください'; end if;
  insert into public.memberships (store_id, user_id, role) values (p_store, v_user, p_role)
  on conflict (store_id, user_id) do update set role = excluded.role, active = true
  returning id into v_id;
  return v_id;
end $$;

-- 繰り返しタスク生成（冪等）。アプリ起動時に呼ばれ、pg_cron からも呼べる。
-- ・(template_id, occurrence_date) の一意制約で二重生成を防止
-- ・last_generated_date から再開するため、失敗・未実行日があっても次回実行で復旧（最大7日遡る）
-- ・明日分まで先行生成
create or replace function public.generate_recurring_tasks(p_store uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_tz text;
  v_today date;
  v_until date;
  v_from date;
  v_d date;
  v_count int := 0;
  v_n int;
  t record;
  v_occurs boolean;
  v_last int;
begin
  -- アプリ経由はメンバーのみ。pg_cron（auth.uid() が null の内部実行）は許可
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
                                  due_date, due_time, template_id, occurrence_date, created_by)
        values (t.store_id, t.title, t.description, t.assignee_id, t.priority, t.category,
                v_d, t.due_time, t.id, v_d, t.created_by)
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

-- 全店舗分（pg_cron 用）
create or replace function public.generate_recurring_tasks_all()
returns int language plpgsql security definer set search_path = public as $$
declare s record; v int := 0;
begin
  for s in select id from public.stores loop
    begin
      v := v + public.generate_recurring_tasks(s.id);
    exception when others then
      raise warning 'generate failed for store %: %', s.id, sqlerrm; -- 1店舗の失敗で全体を止めない
    end;
  end loop;
  return v;
end $$;

-- 内部用関数をクライアントから呼べないようにする
revoke execute on function public.generate_recurring_tasks_all() from public, anon, authenticated;
revoke execute on function public.create_store(text) from public, anon;
revoke execute on function public.add_member_by_email(uuid, text, public.member_role) from public, anon;
revoke execute on function public.generate_recurring_tasks(uuid) from public, anon;
grant execute on function public.create_store(text) to authenticated;
grant execute on function public.add_member_by_email(uuid, text, public.member_role) to authenticated;
grant execute on function public.generate_recurring_tasks(uuid) to authenticated;

-- ========== 任意: pg_cron による毎日の自動生成（Free プランで利用可） ==========
-- ダッシュボード > Database > Extensions で pg_cron を有効化後、以下を実行（毎日 0:05 JST = 15:05 UTC）
-- select cron.schedule('naoru-generate-recurring', '5 15 * * *', $$select public.generate_recurring_tasks_all()$$);
