# NAORU TASK

NAORU整体スタッフ向けのタスク管理Webアプリ（MVP）。**初期費用・月額費用 0円**で運用できる構成です。

- React 19 + TypeScript + Vite + Tailwind CSS v4
- Supabase Free（Auth / Postgres + RLS）
- Cloudflare Pages Free（静的ホスティング・`*.pages.dev` 無料サブドメイン）
- Google Calendar API（無料枠・課金アカウント不要の範囲）

## ローカルで動かす

```bash
npm install
npm run dev
```

`.env` が無い場合は **デモモード**（ブラウザの localStorage のみ・外部通信なし）で起動します。
ログイン画面で「山田 院長 / 佐藤 / 鈴木」を選んで操作を試せます。

Supabase に接続する場合は `.env.example` を `.env` にコピーして値を設定します（手順: [docs/SETUP.md](docs/SETUP.md)）。

## テスト

```bash
npm test          # 繰り返しタスク・期限判定のユニットテスト
npm run build     # 型チェック + 本番ビルド
```

DB（RLS・トリガー・重複生成防止）のテスト手順は [docs/OPERATIONS.md](docs/OPERATIONS.md) を参照。

## ドキュメント

- [docs/SETUP.md](docs/SETUP.md) — Supabase / Cloudflare Pages / Google カレンダーの無料設定手順
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — 無料枠の確認方法・超過時の対応・バックアップ/復元
- [docs/PROGRESS.md](docs/PROGRESS.md) — 開発進捗・次の作業（作業再開用）

## 構成

```
src/lib/types.ts         型定義
src/lib/dates.ts         日付・期限判定（Asia/Tokyo）
src/lib/recurrence.ts    繰り返し規則（SQL版と同じ規則）
src/lib/repo.ts          データ層インターフェース
src/lib/supabaseRepo.ts  Supabase 実装
src/lib/demoRepo.ts      デモ（localStorage）実装
src/lib/calendar.ts      Google カレンダー一方向同期
src/lib/app.tsx          アプリ状態（楽観的更新・再取得の間引き）
src/pages/*              ホーム / マイタスク / カレンダー / チーム管理 / 管理設定
supabase/migrations/     DBスキーマ・RLS・RPC
```

医療情報（患者氏名・症状など）は保存しない設計です。業務の完了状態のみを管理します。
