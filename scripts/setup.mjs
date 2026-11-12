import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE_REQUIRED_KEYS = [
  'GEMINI_API_KEY',
  'LINE_CHANNEL_SECRET',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'ALLOWED_LINE_USER_ID'
];

const ALL_POSSIBLE_KEYS = [
  'GEMINI_API_KEY',
  'LINE_CHANNEL_SECRET',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'ALLOWED_LINE_USER_ID',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  'GOOGLE_SERVICE_ACCOUNT_KEY',
  'GOOGLE_CALENDAR_ID',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN'
];

function run(cmd, options = {}) {
  return execSync(cmd, { stdio: 'inherit', ...options });
}

function runCapture(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return err.stdout?.toString() || err.message || '';
  }
}

async function main() {
  console.log('====================================================');
  console.log(' LINE就活日程調整Bot セットアップ＆デプロイ');
  console.log('====================================================\n');

  // 1. Cloudflare ログイン確認
  console.log('--- [1/5] Cloudflare ログイン状態の確認 ---');
  const whoamiOutput = runCapture('npx wrangler whoami');
  if (whoamiOutput.includes('You are not authenticated') || whoamiOutput.includes('Please run `wrangler login`')) {
    console.log('Cloudflare に未ログインです。ブラウザを開いてログインを行います...');
    run('npx wrangler login');
  } else {
    console.log('✓ Cloudflare にログイン済みです。\n');
  }

  // 2. D1 データベースの準備と wrangler.jsonc の自動更新
  console.log('--- [2/5] D1 データベースの準備 ---');
  const configPath = path.resolve('wrangler.jsonc');
  let configText = fs.readFileSync(configPath, 'utf8');

  if (configText.includes('REPLACE_WITH_YOUR_DATABASE_ID')) {
    console.log('D1 データベース "line-job-calendar" を確認中...');
    let databaseId = null;

    try {
      const listOutput = runCapture('npx wrangler d1 list --json');
      const jsonStart = listOutput.indexOf('[');
      const jsonEnd = listOutput.lastIndexOf(']');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const dbs = JSON.parse(listOutput.slice(jsonStart, jsonEnd + 1));
        const existing = dbs.find(d => d.name === 'line-job-calendar');
        if (existing && (existing.uuid || existing.database_id)) {
          databaseId = existing.uuid || existing.database_id;
          console.log(`✓ 既存の D1 データベースが見つかりました: ${databaseId}`);
        }
      }
    } catch {}

    if (!databaseId) {
      console.log('新規に D1 データベース "line-job-calendar" を作成します...');
      const createOutput = runCapture('npx wrangler d1 create line-job-calendar');
      console.log(createOutput);
      const match = /database_id\s*=\s*"([a-f0-9-]+)"/i.exec(createOutput) ||
                    /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i.exec(createOutput);
      if (match) {
        databaseId = match[1];
      } else {
        throw new Error('D1 データベース ID の取得に失敗しました。出力をご確認ください。');
      }
      console.log(`✓ D1 データベースを作成しました: ${databaseId}`);
    }

    configText = configText.replace('REPLACE_WITH_YOUR_DATABASE_ID', databaseId);
    fs.writeFileSync(configPath, configText, 'utf8');
    console.log('✓ wrangler.jsonc の database_id を更新しました。\n');
  } else {
    console.log('✓ wrangler.jsonc の database_id は設定済みです。\n');
  }

  // 3. D1 マイグレーションの適用
  console.log('--- [3/5] D1 マイグレーションの適用 (本番DB) ---');
  run('npx wrangler d1 migrations apply DB --remote', { env: { ...process.env, CI: 'true' } });
  console.log('✓ D1 マイグレーションが完了しました。\n');

  // 4. .dev.vars の入力チェックと Cloudflare Secrets の一括登録
  console.log('--- [4/5] 環境変数の確認と Cloudflare Secrets の登録 ---');
  const devVarsPath = path.resolve('.dev.vars');
  const secrets = {};
  let hasEmpty = false;

  if (fs.existsSync(devVarsPath)) {
    const content = fs.readFileSync(devVarsPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (val) {
          secrets[key] = val;
        }
      }
    }
  }

  console.log('環境変数の設定状況:');
  for (const key of BASE_REQUIRED_KEYS) {
    if (secrets[key]) {
      console.log(`  - ${key}: [設定済み]`);
    } else {
      console.log(`  - ${key}: [未設定]`);
      hasEmpty = true;
    }
  }

  const hasSA = !!(secrets.GOOGLE_SERVICE_ACCOUNT_KEY || (secrets.GOOGLE_SERVICE_ACCOUNT_EMAIL && secrets.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY));
  const hasOAuth = !!(secrets.GOOGLE_CLIENT_ID && secrets.GOOGLE_CLIENT_SECRET && secrets.GOOGLE_REFRESH_TOKEN);

  if (hasSA) {
    console.log('  - Google認証方式: [サービスアカウント方式 (推奨・無期限)]');
    if (secrets.GOOGLE_CALENDAR_ID) {
      console.log(`  - GOOGLE_CALENDAR_ID: [設定済み (${secrets.GOOGLE_CALENDAR_ID})]`);
    } else {
      console.log('  - GOOGLE_CALENDAR_ID: [未設定] ※サービスアカウント連携ではカレンダーID（あなたのGmailアドレス等）が必須です');
      hasEmpty = true;
    }
  } else if (hasOAuth) {
    console.log('  - Google認証方式: [OAuth 2.0 方式 (旧方式)]');
    if (secrets.GOOGLE_CALENDAR_ID) {
      console.log(`  - GOOGLE_CALENDAR_ID: [設定済み (${secrets.GOOGLE_CALENDAR_ID})]`);
    }
  } else {
    console.log('  - Google認証方式: [未設定] (サービスアカウントまたはOAuthのいずれかを設定してください)');
    hasEmpty = true;
  }

  const validKeys = Object.keys(secrets).filter(k => ALL_POSSIBLE_KEYS.includes(k));
  if (validKeys.length > 0) {
    console.log(`\n${validKeys.length} 件のシークレットを Cloudflare Workers に一括登録します...`);
    const tempFile = path.resolve(`.temp-secrets-${Date.now()}.json`);
    try {
      const payload = {};
      for (const k of validKeys) payload[k] = secrets[k];
      fs.writeFileSync(tempFile, JSON.stringify(payload), 'utf8');
      run(`npx wrangler secret bulk "${tempFile}"`);
      console.log('✓ Cloudflare Secrets を一括登録しました。\n');
    } finally {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
    }
  } else {
    console.log('\n※ 設定されたシークレットがありません。.dev.vars に値を入力してください。\n');
  }

  if (hasEmpty) {
    console.log('⚠️ 一部の環境変数が未設定です。Botを稼働させるにはすべての項目が必要です。');
    console.log('   .dev.vars に値を追記して、再度 `npm run setup` を実行してください。\n');
  }

  // 5. Worker のデプロイ
  console.log('--- [5/5] Cloudflare Workers のデプロイ ---');
  run('npx wrangler deploy');

  console.log('\n====================================================');
  console.log('🎉 デプロイ処理が完了しました！');
  console.log('LINE Developers コンソールの「Webhook設定」に、上記のデプロイ結果で表示された');
  console.log('Worker URL の末尾に `/webhook` を付与したアドレスを設定してください:');
  console.log('  例: https://line-job-calendar.<あなたのサブドメイン>.workers.dev/webhook');
  console.log('====================================================\n');
}

main().catch(err => {
  console.error('\n❌ セットアップ中にエラーが発生しました:', err.message);
  process.exit(1);
});
