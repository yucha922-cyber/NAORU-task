-- 0005: スタッフ同士でタスクを割り当て可能に / 「選んだメンバーだけ」で実施するタスク
-- 追加・変更のみ（既存データは変更しない）。再実行しても安全。
--
-- assignment_mode:
--   single   : 担当者1人（または未割当＝誰か1人が実施すれば完了）
--   everyone : 店舗の全員が各自実施
--   group    : 選んだ複数メンバーが各自実施（全員完了で完了）。メンバーは task_assignees に保存

-- ===== 割当方式に group を追加 =====
alter table public.tasks drop constraint if exists tasks_assignment_mode_check;
alter table public.tasks add constraint tasks_assignment_mode_check check (assignment_mode in ('single', 'everyone', 'group'));
alter table public.tasks drop constraint if exists tasks_everyone_no_assignee;
alter table public.tasks add constraint tasks_everyone_no_assignee check (assignment_mode = 'single' or assignee_id is null);

alter table public.task_templates add column if not exists assignee_ids uuid[] not null default '{}';
alter table public.task_templates drop constraint if exists task_templates_assignment_mode_check;
alter table public.task_templates add constraint task_templates_assignment_mode_check check (
  assignment_mode in ('single', 'everyone', 'group')
  and (assignment_mode = 'single' or assignee_id is null)
  and (assignment_mode = 'group' or cardinality(assignee_ids) = 0)
);

-- ===== 担当者は同じ店舗の有効なメンバーに限る（誰でも割り当てできるようにするための安全策） =====
create or replace function public.tasks_validate_assignee()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    if not exists (select 1 from public.memberships where store_id = new.store_id and user_id = new.assignee_id and active) then
      raise exception '担当者はこの店舗の有効なメンバーから選んでください';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists tasks_validate_assignee on public.tasks;
create trigger tasks_validate_assignee before insert or update on public.tasks
  for each row execute function public.tasks_validate_assignee();

-- ===== RLS: スタッフも他のメンバーにタスクを割り当て・編集できる =====
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.is_member(store_id) and created_by = auth.uid() and template_id is null);

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (
    public.is_member(store_id) and (
      public.is_manager(store_id) or assignee_id = auth.uid() or assignee_id is null or created_by = auth.uid()
      or exists (select 1 from public.task_assignees a where a.task_id = tasks.id and a.user_id = auth.uid())
    )
  )
  with check (public.is_member(store_id));

-- ===== 割当方式の切り替え時の担当行 =====
create or replace function public.tasks_sync_assignees()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assignment_mode = 'everyone' and (tg_op = 'INSERT' or old.assignment_mode <> 'everyone') then
    insert into public.task_assignees (task_id, user_id, store_id)
    select new.id, m.user_id, new.store_id from public.memberships m
    where m.store_id = new.store_id and m.active
    on conflict do nothing;
  elsif tg_op = 'UPDATE' and new.assignment_mode = 'single' and old.assignment_mode <> 'single' then
    delete from public.task_assignees where task_id = new.id;
  end if;
  return new;
end $$;

-- ===== 選んだメンバーを設定（作成者・担当者・院長/管理者が実行可） =====
create or replace function public.set_task_assignees(p_task uuid, p_users uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare v_task record; v_open int;
begin
  select * into v_task from public.tasks where id = p_task;
  if v_task is null or not public.is_member(v_task.store_id) then raise exception '権限がありません'; end if;
  if not (public.is_manager(v_task.store_id) or v_task.created_by = auth.uid() or v_task.assignee_id = auth.uid()
          or exists (select 1 from public.task_assignees a where a.task_id = p_task and a.user_id = auth.uid())) then
    raise exception '権限がありません';
  end if;
  if v_task.assignment_mode <> 'group' then raise exception 'メンバー選択のタスクではありません'; end if;
  if coalesce(cardinality(p_users), 0) < 2 then raise exception '2人以上選んでください'; end if;
  if exists (select 1 from unnest(p_users) u where not exists (
      select 1 from public.memberships m where m.store_id = v_task.store_id and m.user_id = u and m.active)) then
    raise exception '担当者はこの店舗の有効なメンバーから選んでください';
  end if;
  delete from public.task_assignees where task_id = p_task and not (user_id = any (p_users));
  insert into public.task_assignees (task_id, user_id, store_id)
  select p_task, u, v_task.store_id from unnest(p_users) u
  on conflict do nothing;
  -- 全員完了かどうかを再計算
  select count(*) into v_open from public.task_assignees where task_id = p_task and status = 'open';
  if v_open = 0 and v_task.status = 'open' then update public.tasks set status = 'done' where id = p_task;
  elsif v_open > 0 and v_task.status = 'done' then update public.tasks set status = 'open' where id = p_task;
  end if;
end $$;
revoke execute on function public.set_task_assignees(uuid, uuid[]) from public, anon;
grant execute on function public.set_task_assignees(uuid, uuid[]) to authenticated;

-- ===== 繰り返し生成: group のメンバーを引き継ぐ =====
create or replace function public.generate_recurring_tasks(p_store uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_tz text; v_today date; v_until date; v_from date; v_d date;
  v_count int := 0; v_n int; t record; v_occurs boolean; v_last int; v_id uuid;
begin
  if auth.uid() is not null and not public.is_member(p_store) then raise exception '権限がありません'; end if;
  perform pg_advisory_xact_lock(hashtext('gen:' || p_store::text));
  select timezone into v_tz from public.stores where id = p_store;
  if v_tz is null then return 0; end if;
  v_today := (now() at time zone v_tz)::date;
  v_until := v_today + 1;
  for t in select * from public.task_templates where store_id = p_store and active loop
    v_from := greatest(coalesce(t.last_generated_date + 1, t.start_date), v_today - 7, t.start_date);
    v_d := v_from;
    while v_d <= v_until and (t.end_date is null or v_d <= t.end_date) loop
      v_last := extract(day from (date_trunc('month', v_d) + interval '1 month - 1 day'))::int;
      v_occurs := case t.frequency
        when 'daily' then true
        when 'weekly' then extract(dow from v_d)::int = any (t.weekdays)
        when 'interval' then ((v_d - t.start_date) % greatest(t.interval_days, 1)) = 0
        when 'monthly' then extract(day from v_d)::int = least(t.day_of_month, v_last)
        else false end;
      if v_occurs then
        v_id := null;
        insert into public.tasks (store_id, title, description, assignee_id, priority, category,
                                  due_date, due_time, template_id, occurrence_date, created_by, assignment_mode, color_id)
        values (t.store_id, t.title, t.description, case when t.assignment_mode = 'single' then t.assignee_id else null end,
                t.priority, t.category, v_d, t.due_time, t.id, v_d, t.created_by, t.assignment_mode, t.color_id)
        on conflict (template_id, occurrence_date) where template_id is not null do nothing
        returning id into v_id;
        v_n := case when v_id is null then 0 else 1 end;
        -- 選んだメンバーだけで実施するタスク: テンプレートのメンバー（現在も有効な人）を担当にする
        if v_id is not null and t.assignment_mode = 'group' then
          insert into public.task_assignees (task_id, user_id, store_id)
          select v_id, m.user_id, t.store_id from public.memberships m
          where m.store_id = t.store_id and m.active and m.user_id = any (t.assignee_ids)
          on conflict do nothing;
        end if;
        v_count := v_count + v_n;
      end if;
      v_d := v_d + 1;
    end loop;
    update public.task_templates set last_generated_date = greatest(coalesce(last_generated_date, v_until), v_until)
    where id = t.id;
  end loop;
  return v_count;
end $$;
revoke execute on function public.generate_recurring_tasks(uuid) from public, anon;
grant execute on function public.generate_recurring_tasks(uuid) to authenticated;
