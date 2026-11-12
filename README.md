# LINE 就活カレンダー Bot（個人用・初期版）

LINEに企業の案内文を転送または貼り付けると、面談・説明会の日程とURLを整理します。候補カードの「登録」を押した予定だけGoogleカレンダーへ追加し、前日20時と当日10分前の通知を設定します。

このファイル一式には実際のAPIキー・アカウント情報は入っていません。コードと外部サービスを模したテストを用意した段階で、公開や実アカウントでの動作確認はまだです。

## まず行うこと：LINE側の準備

Gemini APIキーの作成が済んでいる場合、次はここからです。

1. [LINE Official Account Manager](https://manager.line.biz/)を開き、自分のLINEアカウントでログインします。
2. 無料のLINE公式アカウントを作成します。名前は「就活カレンダー」などで構いません。企業との既存トークを置き換えるものではなく、自分が案内を送る専用Botです。
3. 対象アカウントの「設定」→「Messaging API」から、Messaging APIを有効にします。画面の案内に従い、開発者情報・プロバイダーを登録します。
4. [LINE Developersコンソール](https://developers.line.biz/console/)で、同じプロバイダー内に作成されたMessaging APIチャネルを開きます。
5. 「Messaging API設定」からチャネルアクセストークン（長期）を発行して、自分だけが見られる場所に保管します。
6. 「チャネル基本設定」で「チャネルシークレット」と「あなたのユーザーID」を確認します。「あなたのユーザーID」はUで始まる文字列で、普段の友だち検索用LINE IDとは異なります。表示されない場合はBusiness IDに自分のLINEアカウントを連携します。
7. 「Messaging API設定」のQRコードなどから、この公式アカウントを自分のLINEで友だち追加します。

キー、トークン、シークレット、ユーザーIDの値をチャットへ送る必要はありません。後述のCloudflare Secretsに保存します。Webhook URLの設定はサーバー公開後に行います。

## 全体の構成

| 役割 | 利用するもの |
| --- | --- |
| 案内文の入力・確認 | LINE公式アカウント＋Messaging API |
| 文章からの予定抽出 | Gemini API（初期モデル：gemini-3.1-flash-lite） |
| Webhookの受付 | Cloudflare Workers |
| 確認待ち候補・重複防止 | Cloudflare D1 |
| 予定とURLの保存・通知 | 自分のGoogleカレンダー |

スマホに専用アプリをインストールする必要はありません。パソコンを起動したままにする必要もありません。

## パソコンの準備

Node.js 22.13以降（Node.js 24 LTS推奨）と、Cloudflareの無料アカウントを用意します。[Node.js](https://nodejs.org/)を入れ、ZIPを展開した`line-calendar-bot`フォルダーをVS Codeなどで開きます。

Windowsではターミナルの種類を「Command Prompt／コマンドプロンプト」にすると、PowerShellのスクリプト実行ポリシーによるnpmのエラーを避けられます。

```sh
npm install
npm test
npx wrangler login
npm run db:create
```

`db:create`の結果に表示される`database_id`を、`wrangler.jsonc`の`REPLACE_WITH_YOUR_DATABASE_ID`に書き入れます。続けて、データベースのテーブルを作ってサーバーを公開します。

```sh
npm run db:remote
npm run deploy
```

この段階では認証情報が未設定なので、予定の処理はできません。表示された`https://line-job-calendar.自分のサブドメイン.workers.dev`形式のURLを控えてください。独自ドメインの購入は不要です。

## Googleカレンダーとの連携

Gemini APIキーだけではカレンダーへのアクセスは許可されません。自分のカレンダーに対するOAuth認証を別に設定します。まずは個人のGoogleアカウントを使うのが分かりやすいです。大学などの管理アカウントでは管理者の制限がある場合があります。

1. [Google Cloud Console](https://console.cloud.google.com/)でプロジェクトを作成、または選択します。
2. 「APIとサービス」のライブラリから**Google Calendar API**を有効にします。
3. Google Auth Platform（OAuth同意画面）の基本情報を設定します。個人アカウントなら対象は「外部」、テストユーザーに自分のGoogleアカウントを追加します。
4. OAuthクライアントを**ウェブアプリケーション**として作成します。「承認済みのリダイレクトURI」に`https://developers.google.com/oauthplayground`を追加します。
5. クライアントIDとクライアントシークレットを自分だけが見られる場所に保存します。
6. [Google公式 OAuth Playground](https://developers.google.com/oauthplayground/)を開きます。右上の歯車から**Use your own OAuth credentials**をオンにし、自分で作ったクライアントID・シークレットを入力します。既定のPlaygroundクライアントを使うと、トークンが24時間で取り消されるため、必ず自分のものを使います。
7. Step 1のスコープ欄に`https://www.googleapis.com/auth/calendar.events`を指定し、Authorize APIsを押します。予定を保存したいGoogleアカウントで許可します。
8. Step 2で**Exchange authorization code for tokens**を押し、取得した**Refresh token**を保管します。Access tokenではありません。Refresh tokenが出ない場合は歯車でAccess typeをOffline、Force promptをConsentにして再認証します。

「テスト」状態のOAuthアプリでは、今回のスコープのリフレッシュトークンは原則7日で期限切れになります。まず動作確認し、継続運用するときにOAuthアプリの公開ステータスと検証要件を確認して本番運用の設定へ移行してください。権限の取り消しなどでも再認証が必要になることがあります。初期版では認証エラー時にLINEへ設定更新の案内を返します。

`GOOGLE_CALENDAR_ID`の初期値は`primary`です。就活専用カレンダーに分ける場合は、自分が所有するカレンダーをGoogleカレンダーで作り、「設定と共有」→「カレンダーの統合」からカレンダーIDを取得して`wrangler.jsonc`の値を変更します。OAuthで認証した本人のカレンダーを使ってください。

## 秘密情報をサーバーへ保存

以下をターミナルから1つずつ実行します。入力待ちになったら対応する値を貼り付けてEnterを押します。値をコマンドそのものやソースコードへ書き込む必要はありません。

```sh
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put ALLOWED_LINE_USER_ID
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

| 設定名 | 入れる値 |
| --- | --- |
| GEMINI_API_KEY | 作成済みのGemini APIキー |
| LINE_CHANNEL_SECRET | LINEのチャネルシークレット |
| LINE_CHANNEL_ACCESS_TOKEN | LINEのチャネルアクセストークン（長期） |
| ALLOWED_LINE_USER_ID | LINE Developersの「あなたのユーザーID」 |
| GOOGLE_CLIENT_ID | 自分で作ったOAuthクライアントID |
| GOOGLE_CLIENT_SECRET | そのOAuthクライアントシークレット |
| GOOGLE_REFRESH_TOKEN | OAuth Playgroundで取得したRefresh token |

この初期版は1人用です。登録したユーザー以外の入力、グループでの入力は処理せず、AIの呼び出しも行いません。

## LINEのWebhookを設定

1. LINE Developersの「Messaging API設定」でWebhook URLを`公開されたWorkerのURL/webhook`に設定します。
2. 「検証」を押して成功を確認し、「Webhookの利用」をオンにします。
3. Webhookの再送機能を有効にできます。同じメッセージの再送は通常、再びAIへ送りません。ただしサーバー障害のタイミングによっては返信が届かないことがあります。その場合は案内文を自分から再送します。
4. LINE Official Account Managerの応答設定で、Botの返信と重複する「応答メッセージ」をオフにします。

Webhookの検証成功は、LINEからURLへ到達できることの確認です。Geminiとカレンダーの接続成功までは確認しません。

## スマホで使って確認

1. スマホのGoogleカレンダーに、OAuth認証に使ったGoogleアカウントを追加します。
2. カレンダーが表示・同期されていること、スマホの設定とGoogleカレンダー内の両方で通知が許可されていることを確認します。
3. LINE Botへ「ヘルプ」と送ると使い方が返ります。
4. 次のような架空の案内を送ります。年月日は必ず、実際に試す日より後に変更してください。

```text
株式会社サンプルの面談
2030年11月20日 15:00〜16:00
オンライン開催
参加URL：https://example.com/meeting
```

5. 企業名・日本時間の日時・URL・確認事項を確認し、「登録」を押します。
6. Googleカレンダーで、予定・参加URL・前日20時と当日10分前の通知が入ったことを確認します。通知の実機テストをする場合は、未来のテスト予定を作り、通知時刻を一時的に近い時刻へ変更して確かめます。
7. テスト予定が不要になったらGoogleカレンダーから削除します。

LINEから自動でリマインドを送る仕組みは使っていません。Googleカレンダーが通知を担当するため、Botのためにパソコンを起動し続ける必要はありません。

## 無料枠に収める設定

- AI呼び出しは初期設定で**日本時間の1日20回まで**。これはアプリ側の自主的な上限で、Geminiが20回分の無料枠を保証する意味ではありません。確認ボタンの操作はAIを呼びません。
- Gemini APIは無料枠のプロジェクトのキーを使ってください。有料枠のプロジェクトを使うと、回数制限内でも課金対象になり得ます。上限到達や通信エラー時に、別の有料モデルへ自動で切り替える処理はありません。
- LINEへの返信はReply APIを使い、定期的なプッシュ送信は使いません。ただしLINEの返信トークンには期限があるため、AIの応答が遅いと返信できない場合があります。そのときは案内文を再送してください。
- Cloudflare WorkersとD1は無料プランで開始してください。無料の処理時間・リクエスト・データベース使用量の上限は別々にあります。無料枠は今後変更される可能性があります。
- Google AI Proの特典を使う場合は、Google Developer Programで月次クレジットを有効化して請求先に適用します。Gemini APIの有料枠と月額契約は別管理で、請求方式によって初期の残高購入が必要です。無料で試す段階では有料化は必須ではありません。

## 初期版の対応範囲

- テキスト1〜8000文字、1メッセージの候補3件まで。候補ごとに独立した登録ボタンが出るため、参加するものだけを選びます。他の候補は自動では登録しません。
- 確認待ち候補の有効期限は24時間です。期限切れの場合は原文を再送します。
- 終了時刻がなければ60分を仮設定し、確認カードに表示します。変更したい場合は候補を取り消し、終了時刻を追記した全文を再送します。
- AIが年を補った場合は確認事項に表示させます。「明日」など、元の送信日がないと決められない表現は年月日の確認を求めます。AIの誤読は完全には防げないので、登録前の日時確認が必要です。
- 重複の判断は、同じ利用者・空白や全角半角を整えたタイトル・開始日時・終了日時を基準にします。異なるタイトルの同一予定までは検出しません。
- 同じタイトル・日時の未登録候補が既にある場合は、最新の案内文の内容（URLや場所など）で候補を上書き更新して再表示します（わざわざ取り消しを押す必要はありません）。登録済みの予定のURL修正はGoogleカレンダーで行います。
- Googleへの作成リクエストにも一定のイベントIDを付けるため、タイムアウト後の再操作でも同じ予定のコピーを増やしません。Googleカレンダー上で一度削除した予定でも、再度同じ案内文から登録を押すことで自動的に復元・更新されます。
- 日程変更・中止の案内は新規登録を止めるようAIに指示し、判定された場合に案内を返します。既存予定の自動変更、空き時間の確認、画像OCR、企業への返信は未対応です。
- 複数候補のうち一つを登録しても、他の候補ボタンは自動では無効になりません。参加しない候補の登録ボタンを押さないでください。

## データの扱い

URLはAIへ送る前に`[URL_1]`などへ置き換え、実際のURLはプログラム側で保持・復元します。一般的な形式のメールアドレス・電話番号も置き換えますが、氏名などを含むあらゆる個人情報を自動除去する機能ではありません。残る本文（企業名・日時など）はGeminiへ送信します。

Gemini APIの無料枠には入力内容の製品改善への利用に関する条件があります。企業からの非公開情報など、外部AIに送ってよいか分からない内容は取り除いてください。

確認候補にはタイトル・日時・場所・URL・確認事項を保存します。原文そのものは保存しません。D1内の確認候補などはアプリ側で別途暗号化していないため、Cloudflareアカウントを共有しないでください。本文やキーをアプリのログへ出す処理は入れていません。

メッセージの重複処理記録は7日、候補記録は最終更新から90日を目安に、次回正常処理時に削除します。独立した定期削除ジョブではないので、Botを使わない間はそのまま残ります。カレンダーの予定は自動削除しません。完全に停止するときはGoogle側のアクセス権を取り消し、WorkerとD1を削除してください。

## 開発者向け

ランタイム依存はなく、WorkerのWeb標準APIとD1を利用しています。`wrangler`は開発・公開用です。

```sh
npm test
npm run db:local
npm run dev
```

ローカル実行時の秘密情報は`.dev.vars`に設定します。このファイルはGit管理対象外です。外部サービスを呼ぶため、ローカルでも実キーを使う場合は利用枠を消費します。`npm test`は架空の値とSQLiteを使い、ネットワークに接続せず、予定も作りません。

ソースの役割：`src/worker.mjs`が受付・確認・状態管理、`src/core.mjs`が署名・入力検証・予定整形、`src/services.mjs`が外部API呼び出しです。`test/bot.test.mjs`では署名、本人限定、確認前の非登録、二重操作、通信途絶後の再試行、URL復元、通知、候補選択などを検証します。

## 公式資料（2026年11月9日に確認）

- [LINE Messaging APIの開始](https://developers.line.biz/ja/docs/messaging-api/getting-started/)
- [LINEユーザーIDの確認](https://developers.line.biz/ja/docs/messaging-api/getting-user-ids/)
- [LINEのWebhook受信](https://developers.line.biz/ja/docs/messaging-api/receiving-messages/)
- [LINE APIの料金と通数](https://developers.line.biz/ja/docs/messaging-api/pricing/)
- [Google OAuth Playground](https://developers.google.com/oauthplayground/)
- [Google OAuthとトークン期限](https://developers.google.com/identity/protocols/oauth2)
- [Google Calendar予定作成API](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Google Calendarの通知](https://developers.google.com/workspace/calendar/api/concepts/reminders)
- [Gemini API料金](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API請求設定](https://ai.google.dev/gemini-api/docs/billing)
- [Google AI Proの開発者特典](https://developers.google.com/program/plans-and-pricing)
- [Cloudflare Workersの制限](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1の無料枠](https://developers.cloudflare.com/d1/platform/pricing/)
