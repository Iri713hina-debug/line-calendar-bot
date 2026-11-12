import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Read .dev.vars safely without logging secrets
const devVarsPath = path.resolve('.dev.vars');
const env = {};
if (fs.existsSync(devVarsPath)) {
  const lines = fs.readFileSync(devVarsPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq !== -1) {
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v) env[k] = v;
    }
  }
}

async function verify() {
  console.log('=== 設定済み認証情報の疎通テスト ===\n');

  // 1. LINE Webhook 署名検証 (LINE_CHANNEL_SECRET)
  if (env.LINE_CHANNEL_SECRET) {
    const webhookUrl = env.WORKER_URL || 'https://line-job-calendar.<your-subdomain>.workers.dev/webhook';
    if (webhookUrl.includes('<your-subdomain>')) {
      console.log('1. LINE Webhook 署名検証: WORKER_URL 未設定のためスキップ（.dev.vars に WORKER_URL を追記すると本番検証できます）');
    } else {
      const body = JSON.stringify({ events: [] });
      const hmac = crypto.createHmac('sha256', env.LINE_CHANNEL_SECRET).update(body).digest('base64');
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-line-signature': hmac
          },
          body
        });
        console.log(`1. LINE Webhook 署名検証 (LINE_CHANNEL_SECRET): HTTP ${res.status} ${res.statusText}`);
        if (res.status === 200) {
          console.log('   ✓ 正常: LINEコンソールの「検証」ボタンと同じリクエストが200 OKで通過しました。');
        } else {
          const text = await res.text();
          console.log(`   ✕ エラー: 期待値200に対して ${res.status} が返りました (レスポンス: ${text.slice(0, 100)})`);
        }
      } catch (e) {
        console.log(`   ✕ 通信失敗: ${e.message}`);
      }
    }
  } else {
    console.log('1. LINE Webhook 署名検証: LINE_CHANNEL_SECRET 未設定のためスキップ');
  }

  // 2. LINE Bot 情報取得 (LINE_CHANNEL_ACCESS_TOKEN)
  if (env.LINE_CHANNEL_ACCESS_TOKEN) {
    try {
      const res = await fetch('https://api.line.me/v2/bot/info', {
        headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }
      });
      console.log(`\n2. LINE Bot 情報取得 (LINE_CHANNEL_ACCESS_TOKEN): HTTP ${res.status} ${res.statusText}`);
      if (res.status === 200) {
        const info = await res.json();
        console.log(`   ✓ 正常: Bot名「${info.displayName || '取得成功'}」(Basic ID: ${info.basicId || ''}) の情報取得に成功しました。`);
      } else {
        console.log(`   ✕ エラー: アクセストークンを確認してください。HTTP ${res.status}`);
      }
    } catch (e) {
      console.log(`   ✕ 通信失敗: ${e.message}`);
    }
  } else {
    console.log('\n2. LINE Bot 情報取得: LINE_CHANNEL_ACCESS_TOKEN 未設定のためスキップ');
  }

  // 3. Gemini API & モデル疎通 (GEMINI_API_KEY)
  if (env.GEMINI_API_KEY) {
    const model = 'gemini-3.1-flash-lite';
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}?key=${env.GEMINI_API_KEY}`);
      console.log(`\n3. Gemini API モデル確認 (${model}): HTTP ${res.status} ${res.statusText}`);
      if (res.status === 200) {
        const data = await res.json();
        console.log(`   ✓ 正常: モデル ${data.displayName || model} は利用可能です。`);
      } else if (res.status === 404) {
        console.log(`   ⚠️ モデル ${model} が 404 です。利用可能なモデル一覧を確認します...`);
        const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`);
        if (listRes.ok) {
          const list = await listRes.json();
          const flashModels = (list.models || []).map(m => m.name.replace('models/', '')).filter(n => n.includes('flash'));
          console.log(`   利用可能な Flash 系モデル: ${flashModels.join(', ')}`);
        }
      } else {
        console.log(`   ✕ エラー: HTTP ${res.status} (APIキーを確認してください)`);
      }
    } catch (e) {
      console.log(`   ✕ 通信失敗: ${e.message}`);
    }
  } else {
    console.log('\n3. Gemini API 疎通: GEMINI_API_KEY 未設定のためスキップ');
  }

  // 4. Google 連携認証 (サービスアカウント方式 または OAuth 2.0 方式)
  let saEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let saKey = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      const parsed = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
      saEmail = saEmail || parsed.client_email;
      saKey = saKey || parsed.private_key;
    } catch {}
  }

  if (saEmail && saKey) {
    console.log('\n4. Google サービスアカウント認証テスト (推奨・無期限方式)');
    try {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const claim = Buffer.from(JSON.stringify({
        iss: saEmail,
        scope: 'https://www.googleapis.com/auth/calendar.events',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
      })).toString('base64url');
      const sign = crypto.createSign('RSA-SHA256');
      sign.update(`${header}.${claim}`);
      const signature = sign.sign(saKey, 'base64url');
      const jwt = `${header}.${claim}.${signature}`;

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt
        })
      });
      console.log(`   サービスアカウント トークン取得: HTTP ${res.status} ${res.statusText}`);
      if (res.status === 200) {
        const tokenData = await res.json();
        console.log(`   ✓ 正常: サービスアカウント (${saEmail}) のアクセストークン取得に成功しました。`);
        const calId = env.GOOGLE_CALENDAR_ID;
        if (!calId) {
          console.log('   ⚠️ GOOGLE_CALENDAR_ID が未設定です。あなたのGmailアドレスを設定して、そのカレンダーの共有設定にサービスアカウントを追加してください。');
        } else {
          try {
            const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?maxResults=1`, {
              headers: { authorization: `Bearer ${tokenData.access_token}` }
            });
            console.log(`\n5. Google Calendar API 共有アクセス (対象: ${calId}): HTTP ${calRes.status} ${calRes.statusText}`);
            if (calRes.status === 200) {
              const calData = await calRes.json();
              console.log(`   ✓ 正常: カレンダー (${calId}, TimeZone: ${calData.timeZone || 'Asia/Tokyo'}) へのアクセス権限を確認しました！`);
            } else {
              const errBody = await calRes.json().catch(() => ({}));
              console.log(`   ✕ エラー: カレンダー共有アクセス失敗 HTTP ${calRes.status}`);
              console.log(`     Googleカレンダーの設定で「特定のユーザーとの共有」に ${saEmail} を追加し、権限を「予定の変更権限」にしてください。`);
              if (errBody.error) console.log(`     詳細: ${errBody.error.message || JSON.stringify(errBody.error)}`);
            }
          } catch (calErr) {
            console.log(`   ✕ カレンダー通信失敗: ${calErr.message}`);
          }
        }
      } else {
        const errText = await res.text();
        console.log(`   ✕ エラー: HTTP ${res.status} (${errText.slice(0, 100)})`);
      }
    } catch (e) {
      console.log(`   ✕ サービスアカウント認証処理エラー: ${e.message}`);
    }
  } else if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          refresh_token: env.GOOGLE_REFRESH_TOKEN,
          grant_type: 'refresh_token'
        })
      });
      console.log(`\n4. Google OAuth トークン更新: HTTP ${res.status} ${res.statusText}`);
      if (res.status === 200) {
        const tokenData = await res.json();
        console.log('   ✓ 正常: Google OAuth アクセストークンの発行に成功しました。');
        if (tokenData.access_token) {
          try {
            const calRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1', {
              headers: { authorization: `Bearer ${tokenData.access_token}` }
            });
            console.log(`\n5. Google Calendar API アクセス (events一覧): HTTP ${calRes.status} ${calRes.statusText}`);
            if (calRes.status === 200) {
              const calData = await calRes.json();
              console.log(`   ✓ 正常: Google Calendar イベントAPI (TimeZone: ${calData.timeZone || 'Asia/Tokyo'}) へのアクセス権限を確認しました。`);
            } else {
              const errBody = await calRes.json().catch(() => ({}));
              console.log(`   ✕ エラー: カレンダーAPIアクセス失敗 HTTP ${calRes.status}`);
              if (errBody.error) {
                console.log(`     理由: ${errBody.error.message || JSON.stringify(errBody.error)}`);
              }
            }
          } catch (calErr) {
            console.log(`   ✕ カレンダー通信失敗: ${calErr.message}`);
          }
        }
      } else {
        console.log(`   ✕ エラー: HTTP ${res.status} (OAuthクライアント設定またはリフレッシュトークンを確認してください)`);
      }
    } catch (e) {
      console.log(`   ✕ 通信失敗: ${e.message}`);
    }
  } else {
    console.log('\n4. Google Calendar 認証: 未設定のためスキップ（サービスアカウントまたはOAuthを設定してください）');
  }
}

verify().catch(console.error);
