# 運用ガイド（無料枠の管理・バックアップ）

## 無料枠と本アプリの想定使用量（渋谷院 少人数）

| サービス | 無料枠（2026-11確認時点） | 想定使用量 | 超過時の挙動 |
|---|---|---|---|
| Supabase DB | 500MB / プロジェクト | 数MB/年（1タスク≈1KB） | 読み取り専用化。課金なし（Free は支払い方法未登録のため） |
| Supabase Auth | 50,000 MAU | 数〜数十人 | — |
| Supabase Egress | 5GB/月 | 数十MB/月 | 制限・警告。課金なし |
| Supabase 一時停止 | 7日間アクセスが無いと停止 | 毎日利用で発生しない | ダッシュボードで「Restore」すれば再開（データは保持） |
| Cloudflare Pages | ビルド 500回/月、静的配信は無制限 | 数十回/月 | ビルド停止（既存公開は継続） |
| Google Calendar API | 100万リクエスト/日・プロジェクト | 数百/日 | 403/429 エラー → アプリは同期を中断して記録 |

※ Google は「上限超過分の課金を2026年後半に導入予定」と告知済み。ただし課金は請求先アカウントをリンクした場合のみ発生するため、**請求先アカウントをリンクしない運用**を徹底してください。

## 使用状況の確認方法（月1回推奨）

- Supabase: ダッシュボード > **Organization > Usage**（DBサイズ・Egress・MAU）
- Cloudflare: ダッシュボード > Workers & Pages > 対象プロジェクト > **Deployments**（ビルド数）
- Google: Cloud Console > APIとサービス > **Google Calendar API > 割り当て**

## 無料枠を超えそうな場合（課金せずに対応）

1. Supabase DB が 400MB を超えたら: 古い完了タスクと操作履歴をバックアップ後に削除（下記SQL）
2. Egress が多い場合: 院長画面の利用頻度を下げる／アプリは既に「画面復帰時に最短60秒間隔で再取得」「リアルタイム購読なし」で最小化済み
3. Google 同期が上限エラー: 自動で中断されます。翌日以降に「今すぐ同期」で再試行。急ぎの場合は手動でカレンダー登録
4. どうしても無料枠に収まらない場合は、有料化せずに機能（Google同期など）を停止し、オーナーに報告

```sql
-- 例: 1年以上前に完了したタスクと操作履歴を削除（実行前に必ずバックアップ）
delete from public.task_activity where created_at < now() - interval '1 year';
delete from public.tasks where status = 'done' and completed_at < now() - interval '1 year';
```

## バックアップ

- **アプリから**: 管理設定 > バックアップ > 「バックアップをダウンロード」（店舗単位の JSON。院長・管理者のみ）
- **DB全体**: Supabase Free には自動バックアップのダウンロード機能が無いため、PC で以下を実行（`pg_dump` は無料）
  ```bash
  pg_dump "postgresql://postgres.[ref]:[DBパスワード]@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres" \
    --schema=public --data-only -f naoru-backup.sql
  ```
- 保存先: 院長のPC＋社内の安全なストレージ（GitHub には **入れない**）

## 復元

1. 新しい Supabase プロジェクトで `0001_init.sql` を実行
2. スタッフにアカウントを再登録してもらう（auth.users は別管理のため）
3. `psql "<接続文字列>" -f naoru-backup.sql` で復元
   - ユーザーIDが変わる場合は JSON バックアップから必要なタスクを再登録

## 繰り返しタスクの仕組みと復旧

- アプリ起動時（その日初回）に `generate_recurring_tasks` を実行し、当日＋翌日分を生成
- `(template_id, occurrence_date)` の一意制約で **二重生成は DB レベルで不可能**
- 実行されなかった日があっても、次回実行時に最大7日分さかのぼって生成（自動復旧）
- 手動で再実行したい場合: SQL Editor で `select public.generate_recurring_tasks('<store_id>');`

## DB テスト（開発者向け）

ローカル PostgreSQL で `auth` スキーマのスタブを作成し、`0001_init.sql` を適用して検証済み:
店舗間の閲覧不可 / スタッフの権限制限 / 2階層制限 / 重複生成なし / 操作履歴の改ざん不可 / 店舗移動不可。
