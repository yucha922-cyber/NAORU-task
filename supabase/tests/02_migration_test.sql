-- 実行順: 00_auth_stub → 0001_init → 01_rls_test（既存データ作成）→ 0002 → 02_migration_test
-- 0002 の検証: 既存データ保持 / 全員向けタスク / 同期状態トリガー / RLS
-- 前提: 00_auth_stub.sql → 0001 → 01_rls_test.sql（既存データ作成）→ 0002 の順に適用済み
\set ON_ERROR_STOP 0
set role authenticated;
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
select id as s1 from stores where name = '渋谷院' \gset
\echo '--- existing data preserved (tasks, templates, activity counts > 0, all single mode)'
select count(*) as tasks, count(*) filter (where assignment_mode = 'single') as single_mode,
       (select count(*) from task_templates) as templates, (select count(*) from task_activity) as activity from tasks;

\echo '--- everyone task: rows for all active members (a, b)'
insert into tasks(store_id,title,created_by,assignment_mode,due_date) values (:'s1','日報提出（全員）','00000000-0000-0000-0000-00000000000a','everyone',current_date) returning id as e \gset
select count(*) as assignee_rows from task_assignees where task_id = :'e';
\echo '--- expect error: everyone + assignee'
insert into tasks(store_id,title,created_by,assignment_mode,assignee_id) values (:'s1','x','00000000-0000-0000-0000-00000000000a','everyone','00000000-0000-0000-0000-00000000000a');

-- calendar link for B on the everyone task (B's own)
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
insert into task_calendar_links(task_id,user_id,store_id,calendar_id,google_event_id,sync_status) values (:'e','00000000-0000-0000-0000-00000000000b',:'s1','cal-b','evb','synced');
\echo '--- expect error: B writes link for A'
insert into task_calendar_links(task_id,user_id,store_id,calendar_id,sync_status) values (:'e','00000000-0000-0000-0000-00000000000a',:'s1','cal-a','synced');
\echo '--- expect error/0: B completes A''s row'
update task_assignees set status='done' where task_id=:'e' and user_id='00000000-0000-0000-0000-00000000000a';
select status from task_assignees where task_id=:'e' and user_id='00000000-0000-0000-0000-00000000000a';
\echo '--- B completes own row -> B link pending, task still open'
update task_assignees set status='done' where task_id=:'e' and user_id='00000000-0000-0000-0000-00000000000b';
select (select sync_status from task_calendar_links where task_id=:'e') as b_link, (select status from tasks where id=:'e') as task_status;
\echo '--- B cannot see A''s google account row; own row works'
insert into google_calendar_accounts(user_id,google_email,calendar_id) values ('00000000-0000-0000-0000-00000000000b','b@gmail.com','cal-b');
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
select count(*) as a_sees_b_account from google_calendar_accounts;
\echo '--- A completes own row -> task done'
update task_assignees set status='done' where task_id=:'e' and user_id='00000000-0000-0000-0000-00000000000a';
select status, completed_at is not null as has_completed_at from tasks where id=:'e';
\echo '--- A reopens -> task open again'
update task_assignees set status='open' where task_id=:'e' and user_id='00000000-0000-0000-0000-00000000000a';
select status from tasks where id=:'e';

\echo '--- manager edits a task -> assignee link marked pending (B sync detects next start)'
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
select id as p from tasks where title='広告動画制作' \gset
insert into task_calendar_links(task_id,user_id,store_id,calendar_id,google_event_id,sync_status) values (:'p','00000000-0000-0000-0000-00000000000b',:'s1','cal-b','evp','synced');
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
update tasks set assignee_id='00000000-0000-0000-0000-00000000000a' where id=:'p';
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
select sync_status as reassigned_link from task_calendar_links where task_id=:'p';
\echo '--- link survives hard delete (so event can be removed later)'
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
delete from tasks where id=:'p';
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
select count(*) as link_after_hard_delete, min(sync_status) as status from task_calendar_links where task_id=:'p';

\echo '--- work time constraint: expect error'
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
insert into tasks(store_id,title,created_by,work_date,work_start,work_end) values (:'s1','x','00000000-0000-0000-0000-00000000000a',current_date,'12:00','11:00');
insert into tasks(store_id,title,created_by,work_date,work_start,work_end) values (:'s1','撮影','00000000-0000-0000-0000-00000000000a',current_date,'10:00','12:00') returning work_start;

\echo '--- everyone template generation: one task per day, rows per member, no dup'
insert into task_templates(store_id,title,frequency,start_date,assignment_mode,category) values (:'s1','カルテ入力確認','daily',current_date,'everyone','karte') returning id as tp \gset
select public.generate_recurring_tasks(:'s1') as gen;
select public.generate_recurring_tasks(:'s1') as gen_again_0;
select count(distinct t.id) as tasks, count(a.*) as assignee_rows from tasks t left join task_assignees a on a.task_id=t.id where t.template_id=:'tp';
reset role;
\echo '--- anon denied'
set role anon;
select count(*) from task_assignees;
