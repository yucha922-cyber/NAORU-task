-- 0004: 未登録のメールアドレスを先に招待できるようにする
-- 院長・管理者がメールアドレスを登録 →（未登録なら「招待中」）→ 本人がそのアドレスでアカウント登録した瞬間に自動で店舗に参加。
-- 追加のみ（既存データは変更しない）。再実行しても安全。

create table if not exists public.store_invitations (
  store_id uuid not null references public.stores (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email like '%_@_%'),
  role public.member_role not null default 'staff',
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (store_id, email)
);
create index if not exists store_invitations_email_idx on public.store_invitations (email);

alter table public.store_invitations enable row level security;
-- 閲覧・取り消しは、その店舗の管理者のみ（追加は invite_member() 経由）
drop policy if exists invitations_select on public.store_invitations;
create policy invitations_select on public.store_invitations for select to authenticated
  using (public.my_role(store_id) = 'admin');
drop policy if exists invitations_delete on public.store_invitations;
create policy invitations_delete on public.store_invitations for delete to authenticated
  using (public.my_role(store_id) = 'admin');
grant select, delete on public.store_invitations to authenticated;
revoke all on public.store_invitations from anon;

-- メンバー追加（登録済みなら即追加 'added'、未登録なら招待 'invited'）
create or replace function public.invite_member(p_store uuid, p_email text, p_role public.member_role)
returns text language plpgsql security definer set search_path = public as $$
declare v_email text := lower(btrim(p_email)); v_user uuid;
begin
  if public.my_role(p_store) is distinct from 'admin' then raise exception '権限がありません'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'メールアドレスの形式が正しくありません'; end if;
  select id into v_user from public.profiles where lower(email) = v_email;
  if v_user is not null then
    insert into public.memberships (store_id, user_id, role) values (p_store, v_user, p_role)
    on conflict (store_id, user_id) do update set role = excluded.role, active = true;
    delete from public.store_invitations where store_id = p_store and email = v_email;
    return 'added';
  end if;
  insert into public.store_invitations (store_id, email, role, invited_by) values (p_store, v_email, p_role, auth.uid())
  on conflict (store_id, email) do update set role = excluded.role, invited_by = excluded.invited_by, created_at = now();
  return 'invited';
end $$;
revoke execute on function public.invite_member(uuid, text, public.member_role) from public, anon;
grant execute on function public.invite_member(uuid, text, public.member_role) to authenticated;

-- 新規ユーザー（プロフィール作成時）に、そのメールアドレス宛ての招待があれば店舗に参加させる
create or replace function public.accept_invitations_on_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.memberships (store_id, user_id, role)
  select i.store_id, new.id, i.role from public.store_invitations i where i.email = lower(btrim(new.email))
  on conflict (store_id, user_id) do nothing;
  delete from public.store_invitations where email = lower(btrim(new.email));
  return new;
end $$;
drop trigger if exists accept_invitations_on_profile on public.profiles;
create trigger accept_invitations_on_profile after insert on public.profiles
  for each row execute function public.accept_invitations_on_profile();
