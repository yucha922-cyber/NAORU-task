-- 0007: Googleカレンダーの自動同期（サーバー側・アプリを閉じていても反映）
-- 追加のみ（既存データは変更しない）。再実行しても安全。
--
-- 仕組み
-- - 連携時に Google の更新用トークン（リフレッシュトークン）を Edge Function が受け取り、
--   AES-GCM で暗号化して google_tokens に保存（ブラウザ・ログインユーザーからは一切読めない）
-- - タスクが変わると、関係するユーザーに needs_sync を立てる
-- - 5分ごとに Edge Function「naoru-google」が needs_sync のユーザー（＋15分以上同期していないユーザー）を同期

-- ===== 暗号化済みトークン（サーバー専用） =====
create table if not exists public.google_tokens (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  enc_refresh_token text not null,
  google_email text not null,
  updated_at timestamptz not null default now()
);
alter table public.google_tokens enable row level security;
-- ポリシーなし＝ログインユーザー・匿名ユーザーからは読み書き不可（サービスロールの Edge Function のみ）
revoke all on public.google_tokens from public, anon, authenticated;

-- ===== 同期状態 =====
alter table public.google_calendar_accounts add column if not exists server_sync boolean not null default false;
alter table public.google_calendar_accounts add column if not exists needs_sync boolean not null default false;
create index if not exists gcal_accounts_server_idx on public.google_calendar_accounts (needs_sync, last_sync_at) where server_sync;

-- ===== サーバー専用の設定（定期実行の合言葉など） =====
create table if not exists public.private_config (
  key text primary key,
  value text not null
);
alter table public.private_config enable row level security;
revoke all on public.private_config from public, anon, authenticated;
insert into public.private_config (key, value)
values ('cron_secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- ===== タスクが変わったら、影響するユーザーに「要同期」を立てる =====
create or replace function public.mark_google_needs_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_task uuid;
  v_users uuid[] := '{}';
  v_parent uuid;
begin
  if tg_table_name = 'tasks' then
    v_task := coalesce(new.id, old.id);
    v_parent := coalesce(new.parent_id, old.parent_id);
    v_users := array_remove(array[case when tg_op <> 'DELETE' then new.assignee_id end,
                                  case when tg_op <> 'INSERT' then old.assignee_id end], null);
  else
    v_task := coalesce(new.task_id, old.task_id);
    v_users := array_remove(array[case when tg_op <> 'DELETE' then new.user_id end,
                                  case when tg_op <> 'INSERT' then old.user_id end], null);
    select parent_id into v_parent from public.tasks where id = v_task;
  end if;
  -- 全員・選んだメンバーのタスク、小項目の親（説明欄に一覧が載るため）の担当者も対象
  v_users := v_users || coalesce((select array_agg(user_id) from public.task_assignees where task_id = v_task), '{}');
  if v_parent is not null then
    v_users := v_users
      || coalesce((select array_agg(assignee_id) from public.tasks where id = v_parent and assignee_id is not null), '{}')
      || coalesce((select array_agg(user_id) from public.task_assignees where task_id = v_parent), '{}');
  end if;
  update public.google_calendar_accounts set needs_sync = true
  where server_sync and not needs_sync and user_id = any (v_users);
  return null;
end $$;
drop trigger if exists tasks_mark_google_needs_sync on public.tasks;
create trigger tasks_mark_google_needs_sync after insert or update or delete on public.tasks
  for each row execute function public.mark_google_needs_sync();
drop trigger if exists task_assignees_mark_google_needs_sync on public.task_assignees;
create trigger task_assignees_mark_google_needs_sync after insert or update or delete on public.task_assignees
  for each row execute function public.mark_google_needs_sync();

-- ===== 定期実行（Supabase 上でのみ。pg_cron / pg_net は Free プランで利用可） =====
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron;
    -- 5分ごと: Googleカレンダー自動同期
    perform cron.schedule('naoru-google-sync', '*/5 * * * *', $cron$
      select net.http_post(
        url := 'https://jofozpnppvrtwkkcdozb.supabase.co/functions/v1/naoru-google',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'x-naoru-cron', (select value from public.private_config where key = 'cron_secret')),
        body := jsonb_build_object('action', 'cron'),
        timeout_milliseconds := 60000
      );
    $cron$);
    -- 毎日 0:05（日本時間）: 繰り返しタスクの生成（アプリを誰も開かなくても作られる）
    perform cron.schedule('naoru-generate-recurring', '5 15 * * *', $cron$select public.generate_recurring_tasks_all()$cron$);
  else
    raise notice 'pg_cron / pg_net が無い環境のため定期実行の登録をスキップしました';
  end if;
end $$;
