-- ローカル検証用: Supabase の auth スキーマを模したスタブ（本番では実行しない）
-- 実行: psql -f supabase/tests/00_auth_stub.sql -f supabase/migrations/0001_init.sql && psql -d naoru_test -f supabase/tests/01_rls_test.sql
drop database if exists naoru_test;
create database naoru_test;
\c naoru_test
do $$ begin create role anon nologin; exception when others then null; end $$;
do $$ begin create role authenticated nologin; exception when others then null; end $$;
create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
