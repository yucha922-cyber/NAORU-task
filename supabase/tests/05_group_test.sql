-- 0005 の検証（0001〜0004 と各テストの後に実行）
set role authenticated;
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b'; -- スタッフB
select id as s1 from stores where name = '渋谷院' \gset
\echo '--- staff B assigns a task to admin A (now allowed)'
insert into tasks(store_id,title,created_by,assignee_id) values (:'s1','Aさんへ依頼','00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-00000000000a') returning title;
\echo '--- expect error: assign to someone outside the store (E = other store user)'
insert into tasks(store_id,title,created_by,assignee_id) values (:'s1','x','00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-0000000000ee');
\echo '--- staff B creates group task for A and B'
insert into tasks(store_id,title,created_by,assignment_mode,due_date) values (:'s1','2人のタスク','00000000-0000-0000-0000-00000000000b','group',current_date) returning id as g \gset
select public.set_task_assignees(:'g', array['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b']::uuid[]);
select count(*) as members from task_assignees where task_id = :'g';
\echo '--- expect error: only 1 member'
select public.set_task_assignees(:'g', array['00000000-0000-0000-0000-00000000000a']::uuid[]);
\echo '--- B completes own share -> still open; A completes -> done'
update task_assignees set status='done' where task_id=:'g' and user_id='00000000-0000-0000-0000-00000000000b';
select status from tasks where id=:'g';
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
update task_assignees set status='done' where task_id=:'g' and user_id='00000000-0000-0000-0000-00000000000a';
select status from tasks where id=:'g';
\echo '--- change members to A + C (c joined via invite test as d?) -> uses c (added in 04 test)'
select public.set_task_assignees(:'g', array['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000c']::uuid[]);
select (select status from tasks where id=:'g') as reopened, count(*) as members from task_assignees where task_id=:'g';
\echo '--- recurring group template -> generated task has the 2 members'
insert into task_templates(store_id,title,frequency,start_date,assignment_mode,assignee_ids) values (:'s1','2人で清掃','daily',current_date,'group', array['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b']::uuid[]);
select public.generate_recurring_tasks(:'s1') > 0 as generated;
select count(distinct t.id) as tasks, count(a.*) as rows from tasks t join task_assignees a on a.task_id=t.id where t.title='2人で清掃';
\echo '--- group -> single removes member rows'
update tasks set assignment_mode='single', assignee_id='00000000-0000-0000-0000-00000000000a' where id=:'g';
select count(*) as rows_after_single from task_assignees where task_id=:'g';
