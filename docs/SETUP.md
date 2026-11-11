# セットアップ手順（すべて無料プラン・クレジットカード登録なし）

> ⚠ 以下の外部サービス設定は、オーナーの承認後に実施してください。各サービスで **有料プランへのアップグレード・支払い方法の登録は行わないでください**。

## 1. Supabase（DB・ログイン）

1. https://supabase.com で GitHub アカウントを使ってサインアップ（Free プラン。カード登録不要）
2. 「New project」→ リージョン **Northeast Asia (Tokyo)**、DBパスワードは安全な値を設定して保管
3. **SQL Editor** で `supabase/migrations/0001_init.sql` の内容を貼り付けて実行
4. **Authentication > Sign In / Providers > Email** を有効化
   - 無料の標準メール送信は 1時間あたりの送信数が非常に少ないため、少人数運用では次のどちらかを推奨
     - (A) 「Confirm email」をオフ → 登録後すぐログイン可能（院長がメンバー追加するまで店舗データは見えないため安全）
     - (B) 院長がダッシュボード **Authentication > Users > Add user** でスタッフを作成（メール送信なし）
5. **Authentication > URL Configuration** の Site URL に公開URL（例 `https://naoru-task.pages.dev`）を設定
6. **Project Settings > API** の `Project URL` と `anon public` キーを `.env` に設定
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```
   ※ anon キーは公開前提のキーです（データ保護は RLS が担います）。**service_role キーは絶対にアプリに入れないでください。**
7. 初回: 院長がアカウント登録 → ログイン → 「店舗を作成」で渋谷院を作成（作成者が管理者になります）
8. スタッフが登録した後、管理設定 > スタッフ・権限 からメールアドレスで追加
9. （任意）毎日 0:05 の自動生成: **Database > Extensions** で `pg_cron` を有効化し、SQL ファイル末尾のコメントの `cron.schedule(...)` を実行
   - 設定しなくても、誰かがアプリを開いた時点で当日・翌日分が自動生成されます

## 2a. GitHub Pages（現在の公開方法・無料）

`main` に push すると `.github/workflows/deploy-pages.yml` が自動でビルドし、
`https://yucha922-cyber.github.io/naoru-task/` に公開します（公開リポジトリでは Actions・Pages とも無料）。

- 初回のみ: リポジトリ **Settings > Pages > Build and deployment > Source** を **「GitHub Actions」** に変更
- Supabase 未設定の間は **デモモード**（データはブラウザ内のみ）で表示されます
- Supabase 接続時: **Settings > Secrets and variables > Actions > Variables** に `VITE_SUPABASE_URL` `VITE_SUPABASE_ANON_KEY`（任意で `VITE_GOOGLE_CLIENT_ID`）を登録し、Actions から再実行
- 注意: GitHub Pages の規約は「SaaS など主に商用目的のサイトの無料ホスティング」を認めていません。社内ツールの試用・デモ用途に留め、本番運用は下記の Cloudflare Pages（商用利用可）への移行を推奨します
- 注意: 公開リポジトリのため、ソースコードは誰でも閲覧できます（秘密情報は含めていません。anon キーも公開前提のキーです）

## 2b. Cloudflare Pages（本番運用の推奨先）

1. https://dash.cloudflare.com でサインアップ（Free。カード登録不要）
2. **Workers & Pages > Create > Pages > Connect to Git** でこの GitHub リポジトリを選択
3. ビルド設定: Framework `Vite` / Build command `npm run build` / Output `dist`（`BASE_PATH` は設定不要）
4. 環境変数に `VITE_SUPABASE_URL` `VITE_SUPABASE_ANON_KEY`（必要なら `VITE_GOOGLE_CLIENT_ID`）を設定
5. 公開URLは `https://<プロジェクト名>.pages.dev`（無料。ドメイン購入不要）
6. 社外に見せたくない場合は Cloudflare Zero Trust Access（Free: 50ユーザーまで）で追加の入口制限も可能（任意）

## 3. Google カレンダー連携（任意・0円）

各スタッフが自分の Google アカウントを一度連携すると、**本人が実施すべきタスクだけ**が、本人の Google アカウントに自動作成される専用カレンダー「NAORU TASK」に入ります。既存のカレンダー・予定は閲覧も編集もしません（スコープ `calendar.app.created`）。

### 3-1. Supabase（先に実施）
SQL Editor で `supabase/migrations/0002_calendar_sync_and_everyone_tasks.sql` を実行（既存データは削除されません。再実行しても安全）。
**⚠ アプリを新しい版に更新する前に必ず実行してください。**

### 3-2. Google Cloud（オーナーが1回だけ）
1. https://console.cloud.google.com で新規プロジェクト作成（例: naoru-task）。**請求先アカウント（Billing）はリンクしない**
2. 「APIとサービス」→「ライブラリ」→「Google Calendar API」を有効化
3. 「Google Auth Platform」（旧: OAuth 同意画面）
   - アプリ名: NAORU TASK、サポートメール: オーナーのメール、対象: **外部**
   - データアクセス（スコープ）: `.../auth/calendar.app.created`、`openid`、`.../auth/userinfo.email`
   - 対象ユーザー: 公開ステータス「テスト中」のまま、**テストユーザーに各スタッフの Google アカウントを追加**（最大100人）
4. 「クライアント」→「クライアントを作成」→ 種類「ウェブ アプリケーション」
   - 承認済みの JavaScript 生成元: `https://yucha922-cyber.github.io`（ローカル確認用に `http://localhost:5173` も可）
   - リダイレクト URI は不要
5. 表示された **クライアント ID**（`xxxx.apps.googleusercontent.com`）を控える。**クライアントシークレットは使わない・共有しない**
6. GitHub の Settings → Secrets and variables → Actions → **Variables** に `VITE_GOOGLE_CLIENT_ID` として登録（クライアント ID は公開前提の値）

### 3-3. 制約（テスト中のアプリ）
- Google の仕様で、テスト中アプリの許可は **同意から7日で失効** します。失効後はアプリの「再認証」で再許可（数タップ）
- これを解消するには「アプリを公開」→ 本番化が必要。`calendar.app.created` が機微なスコープに分類される場合は Google の審査（無料。プライバシーポリシーページ等が必要）を受けるまで「未確認のアプリ」警告が表示されます。分類は Cloud Console のスコープ追加画面で確認してください
- アクセストークンは約1時間で切れ、ブラウザのメモリにのみ保持（保存しない）。アプリを閉じている間は同期されません。開いて「反映する」を押すと、その間の変更（他スタッフ・院長による変更や削除も含む）がまとめて反映されます

## 4. Googleカレンダーの自動同期（アプリを閉じていても反映・0円）

Supabase の Edge Function（無料枠: 月50万回）と定期実行（pg_cron）を使い、サーバー側で同期します。

1. **SQL**: SQL Editor で `supabase/migrations/0007_server_google_sync.sql` を実行
   （暗号化トークン用の表・変更検知・5分ごとの定期実行・毎日の繰り返しタスク生成を登録）
2. **秘密情報（Secrets）**: ダッシュボード「Edge Functions」→「Secrets」で次の2つを追加
   - `GOOGLE_CLIENT_ID` … Google のクライアントID（`xxxx.apps.googleusercontent.com`）
   - `GOOGLE_CLIENT_SECRET` … Google Cloud「Google Auth Platform」→「クライアント」→「NAORU TASK Web」のクライアントシークレット
   ※ シークレットはここにだけ入力し、チャット・GitHub・アプリには絶対に書かない
3. **関数の設置**: 「Edge Functions」→「Deploy a new function」→「Via Editor」
   - 画面下の「Function name」に `naoru-google` と入力（左のファイル名「index.ts」は変えない）
   - エディタの中身（サンプルのコード）をすべて消し、`supabase/functions/naoru-google/index.ts` の内容を貼り付けて「Deploy」
   - 関数の設定で「Verify JWT（JWT の検証）」を **オフ**（関数の中でログイン確認と定期実行の合言葉を検証するため）
4. **アプリ**: 各自「設定」→「Googleカレンダー連携」→「自動同期をオンにする」を1回押す

安全設計: Google のリフレッシュトークンは AES-GCM で暗号化して `google_tokens` に保存し、ログインユーザーからは読めません（サービスロールの関数のみ）。暗号鍵はサービスロールキーから導出するため、DB の内容だけが漏れても復号できません。
