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

## 2. Cloudflare Pages（公開）

1. https://dash.cloudflare.com でサインアップ（Free。カード登録不要）
2. **Workers & Pages > Create > Pages > Connect to Git** でこの GitHub リポジトリを選択
3. ビルド設定: Framework `Vite` / Build command `npm run build` / Output `dist`
4. 環境変数に `VITE_SUPABASE_URL` `VITE_SUPABASE_ANON_KEY`（必要なら `VITE_GOOGLE_CLIENT_ID`）を設定
5. 公開URLは `https://<プロジェクト名>.pages.dev`（無料。ドメイン購入不要）
6. 社外に見せたくない場合は Cloudflare Zero Trust Access（Free: 50ユーザーまで）で追加の入口制限も可能（任意）

## 3. Google カレンダー連携（任意）

1. https://console.cloud.google.com で新規プロジェクト作成。**請求先アカウント（Billing）はリンクしない**
   - 課金アカウントが無い限り、上限を超えてもエラーになるだけで請求は発生しません
2. **APIとサービス > ライブラリ** で「Google Calendar API」を有効化
3. **OAuth 同意画面**: User type「外部」、スコープに `.../auth/calendar.app.created` を追加、テストユーザーにスタッフのGoogleアカウントを登録（テストモードは100人まで）
   - テストモードでは約7日ごとに再連携が必要になる場合があります。常用する場合は「本番」公開を検討（このスコープは機密性が低い区分のため審査は軽微の見込み。公開前に要確認）
4. **認証情報 > OAuth クライアント ID**（ウェブアプリ）を作成し、承認済み JavaScript 生成元に `http://localhost:5173` と公開URLを登録
5. クライアントID を `VITE_GOOGLE_CLIENT_ID` に設定（クライアントシークレットは不要・使用しません）
