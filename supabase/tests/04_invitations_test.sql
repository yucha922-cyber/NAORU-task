-- 0004 の検証（00 → 0001 → 01 → 0002 → 0003 → 0004 の後に実行）
set role authenticated;
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
select id as s1 from stores where name = '渋谷院' \gset
\echo '--- admin invites unregistered email -> invited'
select public.invite_member(:'s1', ' KeitoTakeuti@Gmail.com ', 'staff') as r1;
select email, role from store_invitations;
\echo '--- admin adds registered user (c) -> added'
select public.invite_member(:'s1', 'c@x.jp', 'staff') as r2;
\echo '--- expect error: bad email'
select public.invite_member(:'s1', 'not-an-email', 'staff');
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
\echo '--- staff B: cannot invite / cannot see invitations'
select public.invite_member(:'s1', 'evil@x.jp', 'admin');
select count(*) as b_sees_invites from store_invitations;
reset role;
\echo '--- invitee signs up (real auth trigger) -> automatically member as staff, invitation consumed'
insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000dd','keitotakeuti@gmail.com');
select m.role, m.active from memberships m where m.user_id = '00000000-0000-0000-0000-0000000000dd';
select count(*) as invites_left from store_invitations;
\echo '--- unrelated signup gets nothing'
insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000ee','other@x.jp');
select count(*) as other_memberships from memberships where user_id = '00000000-0000-0000-0000-0000000000ee';
