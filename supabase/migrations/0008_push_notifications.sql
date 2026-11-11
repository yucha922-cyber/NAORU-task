-- 0008: 期限が近いタスクの通知（Web Push・無料）とホーム画面アイコンのバッジ
-- 追加のみ。再実行しても安全。

-- 端末ごとの通知の登録（1人が複数端末を登録できる）
create table if not exists public.push_subscriptions (
  endpoint text primary key check (endpoint like 'https://%'),
  user_id uuid not null references public.profiles (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
-- 本人の端末の登録だけ読み書きできる（送信はサーバーの関数が行う）
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.push_subscriptions to authenticated;
revoke all on public.push_subscriptions from anon;

-- 毎朝 8:00（日本時間＝23:00 UTC）に、期限超過・今日・明日のタスクがある人へ通知
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron;
    perform cron.schedule('naoru-push-daily', '0 23 * * *', $cron$
      select net.http_post(
        url := 'https://jofozpnppvrtwkkcdozb.supabase.co/functions/v1/naoru-google',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'x-naoru-cron', (select value from public.private_config where key = 'cron_secret')),
        body := jsonb_build_object('action', 'push-daily'),
        timeout_milliseconds := 60000
      );
    $cron$);
  else
    raise notice 'pg_cron / pg_net が無い環境のため定期実行の登録をスキップしました';
  end if;
end $$;
