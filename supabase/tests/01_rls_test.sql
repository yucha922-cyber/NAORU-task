\set ON_ERROR_STOP 0
grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated;
insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-00000000000a','a@x.jp'),
 ('00000000-0000-0000-0000-00000000000b','b@x.jp'),
 ('00000000-0000-0000-0000-00000000000c','c@x.jp');
set role authenticated;
-- A creates store 1, C creates store 2
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
select public.create_store('渋谷院') as s1 \gset
select public.add_member_by_email(:'s1','b@x.jp','staff') is not null as add_b;
set request.jwt.sub = '00000000-0000-0000-0000-00000000000c';
select public.create_store('FC店') as s2 \gset
insert into tasks(store_id,title,created_by) values (:'s2','他店タスク','00000000-0000-0000-0000-00000000000c');
-- A: parent/child
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
insert into tasks(store_id,title,created_by,assignee_id) values (:'s1','広告動画を1本制作する','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b') returning id as p \gset
insert into tasks(store_id,title,created_by,parent_id) values (:'s1','企画完了','00000000-0000-0000-0000-00000000000a',:'p') returning id as c \gset
\echo '--- expect error: 3 levels'
insert into tasks(store_id,title,created_by,parent_id) values (:'s1','孫','00000000-0000-0000-0000-00000000000a',:'c');
\echo '--- expect error: cross-store parent'
insert into tasks(store_id,title,created_by,parent_id) values (:'s2','x','00000000-0000-0000-0000-00000000000a',:'p');
insert into task_templates(store_id,title,frequency,start_date,category) values (:'s1','日報提出','daily',current_date-3,'daily_report');
insert into task_templates(store_id,title,frequency,interval_days,start_date,category) values (:'s1','HPBブログ','interval',3,current_date-6,'blog');
select public.generate_recurring_tasks(:'s1') as gen1;
select public.generate_recurring_tasks(:'s1') as gen2_should_be_0;
-- simulate failure recovery: reset last_generated_date, rerun -> no duplicates
update task_templates set last_generated_date = null where store_id = :'s1';
select public.generate_recurring_tasks(:'s1') as gen3_should_be_0;
select count(*) as recurring_tasks from tasks where template_id is not null;
-- B (staff)
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
select count(*) as b_visible_tasks, bool_or(title='他店タスク') as sees_other_store from tasks;
select count(*) as b_sees_store2 from stores where id = :'s2';
update tasks set status='done' where id = :'p';
select status, completed_by is not null as has_completed_by from tasks where id=:'p';
\echo '--- expect error/0 rows: staff assigns task to others'
insert into tasks(store_id,title,created_by,assignee_id) values (:'s1','x','00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-00000000000a');
\echo '--- expect 0 rows: staff edits template'
update task_templates set title='hack';
select count(*) as hacked from task_templates where title='hack';
\echo '--- expect error: staff writes activity directly'
insert into task_activity(store_id,task_id,task_title,action) values (:'s1',:'p','x','create');
\echo '--- expect error: staff adds member'
select public.add_member_by_email(:'s1','c@x.jp','admin');
\echo '--- expect error: generate for other store'
select public.generate_recurring_tasks(:'s2');
\echo '--- expect 0 rows: staff updates other store task'
update tasks set title='hack' where store_id=:'s2';
update tasks set due_date=current_date+3, title='広告動画制作' where id=:'p';
update tasks set deleted_at=now() where id=:'c';
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
select action, task_title, changes from task_activity where task_id in (:'p',:'c') order by id;
\echo '--- expect error: move task to another store'
update tasks set store_id=:'s2' where id=:'p';
