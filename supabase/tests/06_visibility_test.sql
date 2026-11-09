-- 0006 の検証
set role authenticated;
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
select id as s1 from stores where name = '渋谷院' \gset
insert into tasks(store_id,title,created_by,assignee_id) values (:'s1','院長の個人タスク','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a');
insert into tasks(store_id,title,created_by,assignee_id) values (:'s1','Cさんの個人タスク','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000c');
insert into tasks(store_id,title,created_by,assignment_mode) values (:'s1','全員タスク','00000000-0000-0000-0000-00000000000a','everyone');
\echo '--- manager A sees all'
select count(*) filter (where title in ('院長の個人タスク','Cさんの個人タスク','全員タスク')) as a_sees from tasks;
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
\echo '--- staff B: no others personal tasks; sees store-wide and the task B created for A'
select bool_or(title='院長の個人タスク') as sees_boss_personal, bool_or(title='Cさんの個人タスク') as sees_c_personal,
       bool_or(title='全員タスク') as sees_everyone, bool_or(title='Aさんへ依頼') as sees_own_request from tasks;
\echo '--- staff B cannot read others activity'
select count(*) filter (where actor_id <> '00000000-0000-0000-0000-00000000000b') as others_activity from task_activity;
\echo '--- staff B cannot update hidden task (0 rows)'
update tasks set title='hack' where title='Cさんの個人タスク';
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
select count(*) as hacked from tasks where title='hack';
