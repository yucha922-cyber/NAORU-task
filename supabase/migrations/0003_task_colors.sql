-- 0003: タスクごとの Google カレンダー表示色
-- 追加のみ（既存データは変更しない）。再実行しても安全。
-- color_id は Google カレンダーの予定の色番号（1〜11）。10（バジル＝緑）は「完了」の目印として予約しているため選択不可。
-- null の場合はカレンダーの標準色。

alter table public.tasks add column if not exists color_id text;
alter table public.task_templates add column if not exists color_id text;
do $$ begin
  alter table public.tasks add constraint tasks_color_id_check
    check (color_id is null or color_id in ('1','2','3','4','5','6','7','8','9','11'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.task_templates add constraint task_templates_color_id_check
    check (color_id is null or color_id in ('1','2','3','4','5','6','7','8','9','11'));
exception when duplicate_object then null; end $$;

-- 色の変更もカレンダー同期の対象にする
create or replace function public.mark_calendar_links_pending()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'tasks' then
    if tg_op = 'DELETE' then
      update public.task_calendar_links set sync_status = 'pending', updated_at = now() where task_id = old.id;
      return old;
    end if;
    if (new.title, new.due_date, new.due_time, new.work_date, new.work_start, new.work_end, new.status,
        new.priority, new.assignee_id, new.deleted_at, new.assignment_mode, new.color_id)
       is distinct from
       (old.title, old.due_date, old.due_time, old.work_date, old.work_start, old.work_end, old.status,
        old.priority, old.assignee_id, old.deleted_at, old.assignment_mode, old.color_id) then
      update public.task_calendar_links set sync_status = 'pending', updated_at = now()
      where task_id = new.id and sync_status <> 'pending';
    end if;
    return new;
  else
    if tg_op = 'DELETE' then
      update public.task_calendar_links set sync_status = 'pending', updated_at = now()
      where task_id = old.task_id and user_id = old.user_id;
      return old;
    end if;
    update public.task_calendar_links set sync_status = 'pending', updated_at = now()
    where task_id = new.task_id and user_id = new.user_id and sync_status <> 'pending';
    return new;
  end if;
end $$;

-- 繰り返しタスク生成: テンプレートの色を引き継ぐ
create or replace function public.generate_recurring_tasks(p_store uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_tz text; v_today date; v_until date; v_from date; v_d date;
  v_count int := 0; v_n int; t record; v_occurs boolean; v_last int;
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
        insert into public.tasks (store_id, title, description, assignee_id, priority, category,
                                  due_date, due_time, template_id, occurrence_date, created_by, assignment_mode, color_id)
        values (t.store_id, t.title, t.description, case when t.assignment_mode = 'everyone' then null else t.assignee_id end,
                t.priority, t.category, v_d, t.due_time, t.id, v_d, t.created_by, t.assignment_mode, t.color_id)
        on conflict (template_id, occurrence_date) where template_id is not null do nothing;
        get diagnostics v_n = row_count;
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
