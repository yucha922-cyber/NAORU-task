-- 0006: タスクの閲覧範囲をデータベース側でも制限（個人情報・業務情報の保護）
-- これまで: 同じ店舗のメンバーなら全タスクを読めた（画面で隠しているだけ）
-- これから:
--   院長・管理者 … 店舗の全タスク
--   スタッフ     … 自分の担当 / 自分が作成 / 店舗全体のタスク（全員・選んだメンバー・未割当）
-- 操作履歴は院長・管理者（スタッフは自分の操作のみ）。
-- 既存データは変更しない。再実行しても安全。

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (
    public.is_member(store_id) and (
      public.is_manager(store_id)
      or assignee_id = auth.uid()
      or created_by = auth.uid()
      or assignment_mode <> 'single'
      or assignee_id is null
    )
  );

drop policy if exists activity_select on public.task_activity;
create policy activity_select on public.task_activity for select to authenticated
  using (public.is_manager(store_id) or (public.is_member(store_id) and actor_id = auth.uid()));
