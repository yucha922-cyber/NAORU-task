-- 0007 の検証（0001〜0006 の後）
reset role;
insert into google_calendar_accounts(user_id, google_email, server_sync) values
  ('00000000-0000-0000-0000-00000000000a','a@gmail.com', true),
  ('00000000-0000-0000-0000-00000000000b','b@gmail.com', true)
on conflict (user_id) do update set server_sync = true, needs_sync = false;
insert into google_tokens(user_id, enc_refresh_token, google_email) values ('00000000-0000-0000-0000-00000000000b','v1:x:y','b@gmail.com');
set role authenticated;
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
\echo '--- logged-in user cannot read encrypted tokens / cron secret (expect errors)'
select * from google_tokens;
select * from private_config;
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
select id as s1 from stores where name = '渋谷院' \gset
\echo '--- A assigns a task to B -> B needs_sync, A not'
insert into tasks(store_id,title,created_by,assignee_id) values (:'s1','Bさんへ','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b') returning id as t \gset
reset role;
select user_id = '00000000-0000-0000-0000-00000000000b' as is_b, needs_sync from google_calendar_accounts order by user_id;
update google_calendar_accounts set needs_sync = false;
set role authenticated; set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
\echo '--- reassign B -> A: both need sync'
update tasks set assignee_id = '00000000-0000-0000-0000-00000000000a' where id = :'t';
reset role;
select count(*) filter (where needs_sync) as both_flagged from google_calendar_accounts;
update google_calendar_accounts set needs_sync = false;
set role authenticated; set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
\echo '--- group task with A,B: completing B share flags both'
insert into tasks(store_id,title,created_by,assignment_mode) values (:'s1','2人','00000000-0000-0000-0000-00000000000a','group') returning id as g \gset
select public.set_task_assignees(:'g', array['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b']::uuid[]);
reset role; update google_calendar_accounts set needs_sync = false;
set role authenticated; set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
update task_assignees set status='done' where task_id=:'g' and user_id='00000000-0000-0000-0000-00000000000b';
reset role;
select count(*) filter (where needs_sync) as group_flagged from google_calendar_accounts;
