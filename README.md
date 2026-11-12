# LINE 就活日程調整 Bot (LINE Job Calendar Bot)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13.0-brightgreen.svg)](https://nodejs.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%26%20D1-orange.svg)](https://workers.cloudflare.com/)
[![Gemini API](https://img.shields.io/badge/Google%20AI-Gemini%20Flash-blueviolet.svg)](https://aistudio.google.com/)

就活や転職活動の案内メール・メッセージを LINE に転送するだけで、Google Gemini AI が「企業名」「日時」「当日の面接URL（Zoom / Google Meet / Teams 等）」を自動抽出。  
確認カードの「カレンダーに登録」をタップするだけで、Googleカレンダーに予定をワンタップ登録し、**「前日20:00」と「当日10分前」のダブル通知**を自動設定する完全セルフホスト型LINE Botです。

PCを起動し続ける必要はなく、すべて無料枠のクラウドサービス上で24時間365日動作します。

---

## 💡 主な特徴

- 🆓 **完全無料枠で運用可能**: Cloudflare Workers（サーバーレス）+ D1（データベース）+ Gemini API（無料枠）+ Google Calendar API により、維持費 **0円** で運用できます。
- 🎯 **面談・面接用URLだけを厳選抽出**: 案内文に企業のコーポレートサイト、マイページ、アクセス地図、署名リンクなどが複数混ざっていても、当日のWeb面談・面接用URL（Zoom, Google Meet, Microsoft Teams, Webex等）だけをAIが賢く判別してカレンダーの場所・メモにセットします。対面面接の場合は住所や会場名を保持します。
- ⏰ **就活生に嬉しいダブル通知設定**: Googleカレンダーの通知機能を利用し、予定開始時刻に合わせて「**前日の夜 20:00**（明日の準備用）」と「**当日の開始10分前**（入室用）」の2回、スマホへ自動リマインド通知を送ります。
- ⚡ **超高速レスポンス（約1.5〜2秒）**: Gemini 3.1 Flash-Lite の思考最適化（`thinkingBudget: 0`）により、4,000文字を超える長い案内メールでも約1.5〜2秒で解析カードを即座にLINEへ返信します。
- 🔒 **プライバシー保護 & URLマスキング**: URLのパスやトークン、電話番号、メールアドレスを事前にプレースホルダー（`[URL_1]` 等）にマスキングしてからAIに送信するため、機密情報がAIモデルに漏洩しません。
- 🛡️ **個人専用セキュリティ**: 登録した管理者（あなた）のLINEユーザーID以外からのメッセージやグループへの招待はすべて安全に遮断します。
- 🔄 **重複防止 & 自動復元**: 同じ日程の二重登録を防止。また、Googleカレンダー上で手動削除した予定も、LINEの案内からもう一度「登録」を押すだけで自動復元・再登録できます。

---

## 🏗️ システム構成

```
[ 就活メール / LINE ]
         │ (案内文を転送 / コピペ)
         ▼
[ LINE Messaging API ]
         │ (Webhook)
         ▼
[ Cloudflare Workers ] ─── (予定候補・重複管理) ─── [ Cloudflare D1 (SQLite) ]
         │
         ├─── (日時・企業名・面談URL抽出) ───► [ Google Gemini API ]
         │                                       (gemini-3.1-flash-lite)
         │
         └─── (「登録」ボタン押下時に予定作成) ─► [ Google Calendar API ]
                                                  (前日20時 & 10分前通知)
```

---

## 📋 準備するもの（事前アカウント登録）

セットアップを始める前に、以下の4つのサービスから必要なキーやトークンを取得します（すべて無料・所要時間 約10〜15分）。

| # | サービス | 取得するもの | 公式リンク |
|---|---|---|---|
| 1 | **Google AI Studio** | `GEMINI_API_KEY` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| 2 | **LINE Developers** | `LINE_CHANNEL_SECRET`<br>`LINE_CHANNEL_ACCESS_TOKEN`<br>`ALLOWED_LINE_USER_ID` | [developers.line.biz/console](https://developers.line.biz/console/)<br>[manager.line.biz](https://manager.line.biz/) |
| 3 | **Google Cloud**<br>（サービスアカウント） | `GOOGLE_SERVICE_ACCOUNT_EMAIL`<br>`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`<br>`GOOGLE_CALENDAR_ID`（あなたのGmail等） | [console.cloud.google.com](https://console.cloud.google.com/)<br>[calendar.google.com](https://calendar.google.com/) |
| 4 | **Cloudflare** | 無料アカウント | [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) |

---

### 詳細な取得手順

<details>
<summary><b>1. Google Gemini API キーの取得手順（クリックして展開）</b></summary>

1. [Google AI Studio (API Keys)](https://aistudio.google.com/app/apikey) にアクセスし、Googleアカウントでログインします。
2. **「Create API key」**（APIキーを作成）をクリックします。
3. 作成された API キー（`AIza...` で始まる文字列）をコピーしてメモします。
</details>

<details>
<summary><b>2. LINE 公式アカウント & Messaging API の準備手順（クリックして展開）</b></summary>

1. [LINE Official Account Manager](https://manager.line.biz/) を開き、「アカウントを作成」から無料のアカウントを作成します（アカウント名は「就活カレンダー」など任意）。
2. 作成したアカウントの設定画面右上の「設定」→ 左メニューの「Messaging API」を開き、**「Messaging APIを利用する」**をクリックします。
3. 開発者名・メールアドレスを入力し、新しいプロバイダーを作成（または既存を選択）して完了します。
4. [LINE Developers コンソール](https://developers.line.biz/console/) を開きます。
5. 先ほど作成したプロバイダー内の Messaging API チャネルをクリックします。
6. **チャネル基本設定**タブ：
   - 下部にある「**チャネルシークレット**」をメモします。
   - さらに下部にある「**あなたのユーザーID**」（`U` から始まる33文字の英数字）をメモします（※これは個人のLINE友だち追加用IDとは異なります）。
7. **Messaging API設定**タブ：
   - ページ最下部の「**チャネルアクセストークン（長期）**」の「発行」ボタンを押し、トークンをメモします。
   - ページ内のQRコードから、作成した公式アカウントを自分のスマホのLINEで「友だち追加」しておきます。
</details>

<details open>
<summary><b>3. Google Calendar 連携の準備手順【推奨：サービスアカウント方式（審査不要・永久無期限）】（クリックして開閉）</b></summary>

OAuth方式（リフレッシュトークン）と異なり、**サービスアカウント方式なら有効期限切れ（7日制限）やGoogleの公開審査が一切ありません**。一度設定すれば永久に動き続けます。

#### ① Google Cloud プロジェクト作成と API 有効化
1. [Google Cloud Console](https://console.cloud.google.com/) を開き、新しいプロジェクトを作成します（例: `line-calendar-bot`）。
2. [Google Calendar API 有効化ページ](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) を開き、**「有効にする」**をクリックします。

#### ② サービスアカウントの作成と鍵（JSON）のダウンロード
1. [IAM と管理 > サービスアカウント](https://console.cloud.google.com/iam-admin/serviceaccounts) を開きます。
2. 上部の **「+ サービス アカウントを作成」** をクリックします。
3. サービス アカウント名に「`calendar-bot`」など任意の名前を入力し、**「作成して続行」** → ロール選択は何も選ばず **「続行」** → **「完了」** を押します。
4. 一覧に作成されたサービスアカウントのメールアドレス（例: `calendar-bot@xxxx.iam.gserviceaccount.com`）が表示されるのでコピーしてメモします（これが `GOOGLE_SERVICE_ACCOUNT_EMAIL` です）。
5. そのメールアドレスをクリックし、上部の **「キー」** タブを開きます。
6. **「鍵を追加」** → **「新しい鍵を作成」** をクリックし、キーのタイプで **「JSON」** を選択して「作成」を押します。
7. ダウンロードされた JSON ファイルをテキストエディタで開きます：
   - `client_email`: サービスアカウントのメールアドレス
   - `private_key`: `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n` で始まる秘密鍵（これが `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` です）

#### ③ 自分の Google カレンダーへ共有（変更権限を付与）
1. ブラウザで [Google カレンダー (Web版)](https://calendar.google.com/) を開きます。
2. 左メニューの「マイカレンダー」から、予定を登録したいカレンダー（通常は自分の名前のカレンダー）の右側にある縦の3点リーダー（︙）をクリックし、**「設定と共有」** を開きます。
3. 「特定のユーザーまたはグループとの共有」セクションまでスクロールし、**「+ ユーザーおよびグループを追加」** をクリックします。
4. **メールアドレス欄**に、先ほどメモしたサービスアカウントのメールアドレス（`...gserviceaccount.com`）を貼り付けます。
5. **権限**を必ず **「予定の変更権限」**（または「予定の管理権限」）に変更し、「送信」を押します。
6. 設定完了です！あなたの Google アカウントのメールアドレス（例: `your-email@gmail.com`）が `GOOGLE_CALENDAR_ID` となります。
</details>

<details>
<summary><b>【互換用】従来の OAuth 2.0 方式で連携する場合（クリックして展開）</b></summary>

※ サービスアカウント方式を利用する場合は設定不要です。

1. [OAuth 同意画面](https://console.cloud.google.com/apis/credentials/consent) で「外部」を選択し、テストユーザーに自分の Gmail アドレスを追加。
2. [認証情報](https://console.cloud.google.com/apis/credentials) からウェブ アプリケーションのクライアント ID を作成（リダイレクト URI に `https://developers.google.com/oauthplayground` を追加）。
3. [OAuth Playground](https://developers.google.com/oauthplayground/) で「Use your own OAuth credentials」から Client ID/Secret を入力し、スコープ `https://www.googleapis.com/auth/calendar.events` で認証して Refresh Token を取得します。
（※ テストモードの OAuth トークンは 7 日間で失効するためご注意ください）
</details>

<details>
<summary><b>4. Cloudflare 無料アカウントの準備（クリックして展開）</b></summary>

1. [Cloudflare サインアップページ](https://dash.cloudflare.com/sign-up) から無料アカウントを作成します（クレジットカードの登録は不要です）。
</details>

---

## 🚀 最短15分！セットアップ手順

本プロジェクトには、D1データベースの作成からテーブルマイグレーション、シークレットの一括暗号化登録、Workerの本番デプロイまでを**全自動で行うセットアップスクリプト**（`scripts/setup.mjs`）が同梱されています。

### 1. リポジトリをクローンして依存関係をインストール

PCに [Node.js](https://nodejs.org/)（v22.13.0 以上推奨）がインストールされていることを確認し、ターミナルで以下を実行します：

```bash
git clone https://github.com/Iri713hina-debug/line-calendar-bot.git
cd line-calendar-bot
npm install
```

### 2. 環境変数設定ファイル（`.dev.vars`）を作成

テンプレートファイルをコピーして `.dev.vars` を作成します：

```bash
# Windows (PowerShell) の場合
cp .dev.vars.example .dev.vars

# macOS / Linux の場合
cp .dev.vars.example .dev.vars
```

エディタで `.dev.vars` を開き、準備した値を入力します：

```ini
# 1. Gemini API Key
GEMINI_API_KEY=AIzaSy...

# 2. LINE Messaging API
LINE_CHANNEL_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LINE_CHANNEL_ACCESS_TOKEN=xxxxxx...
ALLOWED_LINE_USER_ID=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 3. Google Calendar 連携（サービスアカウント方式・推奨）
GOOGLE_SERVICE_ACCOUNT_EMAIL=calendar-bot@xxxx.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_CALENDAR_ID=your-email@gmail.com

# ※ 従来の OAuth 2.0 方式を利用する場合は以下を設定（サービスアカウント利用時は不要）
# GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
# GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
# GOOGLE_REFRESH_TOKEN=1//04xxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> [!IMPORTANT]
> `.dev.vars` には重要なシークレットが含まれるため、Git にコミットしないでください（`.gitignore` で除外されています）。

### 3. ワンコマンド自動セットアップを実行

以下のコマンドを実行します：

```bash
npm run setup
```

**セットアップスクリプトが自動で行うこと：**
1. 初回実行時、ブラウザが自動で開き Cloudflare のログイン承認画面が表示されます（「Allow」をクリック）。
2. Cloudflare D1 にデータベース `line-job-calendar` を自動作成。
3. `wrangler.jsonc` の `database_id` を新規作成された ID に自動更新。
4. D1 にテーブル定義（`migrations/0001_init.sql`）をリモート適用。
5. `.dev.vars` の7つの機密情報を Cloudflare Workers の暗号化シークレットに一括保存。
6. Cloudflare Workers へ本番デプロイ。

完了すると、コンソールに以下のようにデプロイされた公開URLが表示されます：
```text
🎉 セットアップとデプロイがすべて完了しました！
--------------------------------------------------
公開 Webhook URL:
https://line-job-calendar.<your-subdomain>.workers.dev/webhook
--------------------------------------------------
```

### 4. 接続テストを実行

全サービスとの疎通が正常か、自動テストスクリプトで確認します：

```bash
npm run verify
```

以下のようにすべて緑色の `[OK]` が表示されれば準備完了です！
```text
[OK] 1. Gemini API 疎通確認成功 (モデル: gemini-3.1-flash-lite)
[OK] 2. LINE Messaging API 疎通確認成功 (Bot名: 就活カレンダー)
[OK] 3. Google Calendar API 疎通確認成功 (カレンダー: primary)
[OK] 4. 本番 Worker エンドポイント疎通確認 (HTTP 200)
```

---

## 📲 LINE公式アカウント側の最終設定

サーバーの公開が完了したら、LINE側で Webhook を有効化します。

1. [LINE Developers コンソール](https://developers.line.biz/console/) を開きます。
2. 作成したチャネルの **「Messaging API設定」** タブを開きます。
3. **Webhook URL** の「編集」をクリックし、先ほど表示されたURLを入力して「更新」を押します：
   ```text
   https://line-job-calendar.<your-subdomain>.workers.dev/webhook
   ```
4. **「検証」** ボタンを押し、「成功」と表示されることを確認します。
5. **「Webhookの利用」** のトグルスイッチを **オン** にします。
6. [LINE Official Account Manager](https://manager.line.biz/) を開き、対象アカウントの右上の「設定」→「応答設定」を開きます：
   - 応答モード: **「Bot」**（または「チャット」）
   - チャットの応答方法 / 応答メッセージ: **「オフ」**（※ Botの返信と二重に「メッセージありがとうございます」等の自動応答が返るのを防ぎます）

---

## 💬 使い方

自分のスマホの LINE で、友だち追加した公式アカウントのトーク画面を開きます。

### ① 案内文を送る
企業の面接・面談案内メールをコピーしてそのまま貼り付けるか、転送します：

```text
〇〇様

株式会社テックイノベーションの採用担当です。
書類選考を通過されましたので、1次面談をご案内いたします。

■ 日時
2026年11月20日(金) 14:00〜15:00

■ 形式
オンライン（Zoom）

■ 当日の接続URL
https://zoom.us/j/1234567890?pwd=xxxxxx

事前のアンケートはこちら：
https://example.com/survey

何かご不明点がございましたらご連絡ください。
```

### ② 確認カードが返信される
約1.5〜2秒で、以下のような Flex Message カードが届きます：

```
┌─────────────────────────────────┐
│ 📅 予定の確認                   │
│                                 │
│ 企業・用件: 株式会社テックイノベーション 1次面談 │
│ 日時: 2026年11月20日 14:00〜15:00 │
│ 場所: オンライン                │
│ URL: https://zoom.us/j/...      │
│ 通知: 前日20:00・当日10分前     │
│                                 │
│  [ カレンダーに登録 ]           │
│  [ 取り消し ]                   │
└─────────────────────────────────┘
```
※ アンケートURLは除外され、当日の面談用Zoom URLだけが自動抽出されます。

### ③ 「カレンダーに登録」をタップ
ボタンをタップすると、Googleカレンダーに予定が即時追加され、LINEに完了メッセージが届きます。  
スマホの Google カレンダーアプリを開くと、予定が登録され、リマインダーに**「前日20:00」**と**「当日10分前」**が設定されていることが確認できます。

---

## 🛠️ よくある質問・トラブルシューティング

### Q. Googleカレンダーの連携は期限切れになりませんか？
本Botは**Googleサービスアカウント方式（推奨）**に対応しているため、トークン有効期限の概念自体が存在せず、**何ヶ月・何年経っても永久に無期限で連携が持続します**。GoogleのOAuth審査や毎週の再認証に悩まされる心配はありません。  
（※ 互換用のOAuth方式で設定した場合のみ、Googleのセキュリティ仕様によりテストアプリでは7日で失効します。特別な理由がない限りサービスアカウント方式のご利用を推奨します）

### Q. 長いメールを送ると「通信が完了しませんでした」と返ってくる
Gemini API の呼び出しがネットワーク不調等で遅延した場合に返されます。本アプリは自動フォールバック（`gemini-3.1-flash-lite` 失敗時に `gemini-2.5-flash` へ即時切り替え）を備えていますが、数秒待ってから案内文をもう一度送信してください。

### Q. 別の予定が入ってしまったり、誤読された場合は？
カード内の「取り消し」ボタンを押すか、何もしなければ登録されません（候補カードの有効期限は24時間です）。日時の表記が曖昧な場合（例:「来週の金曜日」など）は、案内文に具体的な日付（「2026年11月20日 15:00」）を補記して再送してください。

---

## 🧑‍💻 開発者向けコマンド

```bash
# 単体テストの実行（外部通信なし、モックDB・モックAPIで全27件を即時検証）
npm test

# ローカル D1 データベースの初期化
npm run db:local

# ローカルエミュレーターでの起動
npm run dev

# 手動で Worker をデプロイ
npm run deploy

# 本番のリアルタイムログを監視
npx wrangler tail
```

---

## 📄 ライセンス

このプロジェクトは [MIT License](LICENSE) のもとで公開されています。商用・非商用問わず自由にご利用・改変いただけます。