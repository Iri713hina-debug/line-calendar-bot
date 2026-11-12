import { BotError, digest, eventFingerprint, formatTime, japanDate, prepareSource, verifySignature } from './core.mjs';
import { extract, insertCalendar, reply } from './services.mjs';

const help = '面談・説明会の案内文を、そのまま転送または貼り付けてください。\n企業名・年月日・開始時刻を読み取り、確認用の「登録」ボタンを返します。\n参加する候補だけ登録してください。時刻は日本時間です。\n修正したいときは「取り消す」を押し、修正した案内文の全文を再送してください。\n初期版はテキストと新規予定の登録に対応しています。';
const textMessage = text => ({ type: 'text', text: text.slice(0, 4900) });

function draftMessage(row, index) {
  const e = JSON.parse(row.event_json);
  const lines = [
    `候補${index + 1}：${e.title}`,
    `開始：${formatTime(e.start)}`, `終了：${formatTime(e.end)}`,
    ...(e.location ? [`場所：${e.location.slice(0, 160)}`] : []),
    ...e.warnings.map(w => `確認事項：${w.slice(0, 100)}`),
    ...e.links.map((url, i) => `URL ${i + 1}：${url.length > 130 ? url.slice(0, 90) + '…' + url.slice(-30) + '（全文は原文・カレンダーで確認）' : url}`),
    '通知：前日20:00・当日10分前（Googleカレンダー）',
    '内容を確認し、参加する候補だけ「登録」を押してください。'
  ];
  // Persistent buttons remain available for each candidate after another message arrives.
  return { type: 'flex', altText: `${e.title}：登録内容を確認`, contents: {
    type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: lines.join('\n').slice(0, 1900), wrap: true, size: 'sm' }
    ] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', action: { type: 'postback', label: '登録', data: `confirm:${row.id}` } },
      { type: 'button', action: { type: 'postback', label: '取り消す', data: `cancel:${row.id}` } }
    ] }
  } };
}

async function draftsForMessage(env, user, events, now) {
  const rows = [];
  for (const event of events) {
    const fingerprint = await eventFingerprint(user, event);
    const id = fingerprint.slice(0, 32);
    await env.DB.prepare(`INSERT INTO drafts (id, owner, fingerprint, event_json, status, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(fingerprint) DO NOTHING`)
      .bind(id, user, fingerprint, JSON.stringify(event), now, now, now + 86400000).run();
    let row = await env.DB.prepare('SELECT * FROM drafts WHERE fingerprint = ? AND owner = ?').bind(fingerprint, user).first();
    if (row.status === 'cancelled' || row.status === 'pending') {
      await env.DB.prepare("UPDATE drafts SET event_json = ?, status = 'pending', expires_at = ?, updated_at = ? WHERE id = ? AND status IN ('cancelled', 'pending')")
        .bind(JSON.stringify(event), now + 86400000, now, id).run();
      row = await env.DB.prepare('SELECT * FROM drafts WHERE id = ? AND owner = ?').bind(id, user).first();
    }
    rows.push(row);
  }
  return rows;
}

async function confirm(env, id, user, fetcher, now) {
  const row = await env.DB.prepare('SELECT * FROM drafts WHERE id = ? AND owner = ?').bind(id, user).first();
  if (!row) return textMessage('予定の候補が見つかりません。案内文を送り直してください。');
  if (row.status === 'created') return textMessage(`登録済みです。\n${row.calendar_link || 'Googleカレンダーで確認してください。'}`);
  if (row.status === 'cancelled') return textMessage('この候補は取り消されています。案内文を送り直してください。');
  const event = JSON.parse(row.event_json);
  if (row.expires_at < now || Date.parse(event.start) <= now) return textMessage('候補の有効期限が切れたか、開始時刻を過ぎています。案内文を送り直してください。');
  const claim = await env.DB.prepare(`UPDATE drafts SET status = 'creating', updated_at = ?
    WHERE id = ? AND owner = ? AND (status = 'pending' OR (status = 'creating' AND updated_at < ?)) RETURNING id`)
    .bind(now, id, user, now - 35000).first();
  if (!claim) return textMessage('登録処理中です。少し待ってからGoogleカレンダーを確認してください。');
  try {
    const link = await insertCalendar(env, event, row.fingerprint, fetcher);
    await env.DB.prepare("UPDATE drafts SET status = 'created', calendar_link = ?, updated_at = ? WHERE id = ?")
      .bind(link, now, id).run();
    return textMessage(`登録しました：${event.title}\n${formatTime(event.start)}\n通知：前日20:00・当日10分前\n${link}\nスマホのGoogleカレンダーの通知を有効にしてください。`);
  } catch (error) {
    // The deterministic Google event ID makes another click safe even after a network timeout.
    await env.DB.prepare("UPDATE drafts SET status = 'pending', updated_at = ? WHERE id = ?").bind(now, id).run();
    throw error;
  }
}

async function handleEvent(event, env, fetcher, now) {
  const user = event.source?.userId;
  // Ignore every other user and group before any AI request or database write.
  if (event.source?.type !== 'user' || !env.ALLOWED_LINE_USER_ID || user !== env.ALLOWED_LINE_USER_ID) return;
  if (!event.replyToken) return;
  if (event.type === 'follow') return reply(env, event.replyToken, [textMessage(help)], fetcher);
  if (event.type === 'postback') {
    const m = /^(confirm|cancel):([a-f0-9]{32})$/.exec(event.postback?.data || '');
    if (!m) return;
    let message;
    if (m[1] === 'cancel') {
      const result = await env.DB.prepare("UPDATE drafts SET status = 'cancelled', updated_at = ? WHERE id = ? AND owner = ? AND status = 'pending' RETURNING id")
        .bind(now, m[2], user).first();
      message = textMessage(result ? '候補を取り消しました。カレンダーへの登録は行っていません。' : '取り消せる候補がありません。登録済みの予定はGoogleカレンダーで削除してください。');
    } else message = await confirm(env, m[2], user, fetcher, now);
    return reply(env, event.replyToken, [message], fetcher);
  }
  if (event.type !== 'message') return;
  if (event.message?.type !== 'text') return reply(env, event.replyToken, [textMessage('この初期版は文章のみ対応しています。画像内の案内はテキストにして送ってください。')], fetcher);
  const source = event.message.text.trim();
  if (['ヘルプ', '使い方', 'help'].includes(source.toLowerCase())) return reply(env, event.replyToken, [textMessage(help)], fetcher);
  if (!source || source.length > 8000) return reply(env, event.replyToken, [textMessage('案内文は1〜8000文字で送ってください。')], fetcher);
  // Store no original message text. A webhook redelivery cannot spend another AI call.
  const jobId = await digest(`${user}:${event.webhookEventId || event.message.id}`);
  const job = await env.DB.prepare(`INSERT INTO jobs (id, status, updated_at) VALUES (?, 'running', ?)
    ON CONFLICT(id) DO UPDATE SET status = 'running', updated_at = excluded.updated_at
    WHERE jobs.status = 'running' AND jobs.updated_at < ? RETURNING id`)
    .bind(jobId, now, now - 35000).first();
  if (!job) return;
  try {
    const parsedLimit = Number(env.DAILY_AI_LIMIT || 20);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
    const usage = await env.DB.prepare(`INSERT INTO daily_usage (day, count) VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET count = daily_usage.count + 1 WHERE daily_usage.count < ? RETURNING count`)
      .bind(japanDate(now), limit).first();
    if (!usage) throw new BotError('local-limit', `本日の読み取り上限（${limit}回）に達しました。日本時間の翌日に再送してください。`);
    const events = await extract(env, prepareSource(source), fetcher, now);
    const rows = await draftsForMessage(env, user, events, now);
    const messages = [textMessage('予定の候補です。複数ある場合は、参加する候補だけ登録してください。修正時は取り消して全文を再送します。')];
    rows.forEach((row, i) => messages.push(row.status === 'created'
      ? textMessage(`登録済み：${JSON.parse(row.event_json).title}\n${row.calendar_link || ''}`)
      : draftMessage(row, i)));
    await reply(env, event.replyToken, messages, fetcher);
  } finally {
    await env.DB.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(now, jobId).run();
  }
  await env.DB.prepare('DELETE FROM jobs WHERE updated_at < ?').bind(now - 7 * 86400000).run();
  await env.DB.prepare("DELETE FROM drafts WHERE updated_at < ? AND status != 'creating'").bind(now - 90 * 86400000).run();
  await env.DB.prepare('DELETE FROM daily_usage WHERE day < ?').bind(japanDate(now - 7 * 86400000)).run();
}

export function createHandler(fetcher = fetch, clock = Date.now) {
  return {
    async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/') return new Response('LINE Job Calendar Bot. Webhook: POST /webhook', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (request.method !== 'POST' || path !== '/webhook') return new Response('Not found', { status: 404 });
      if (Number(request.headers.get('content-length') || 0) > 256000) return new Response('Too large', { status: 413 });
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 256000) return new Response('Too large', { status: 413 });
      if (!await verifySignature(raw, request.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET)) return new Response('Unauthorized', { status: 401 });
      let body;
      try { body = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (!Array.isArray(body.events) || body.events.length > 100) return new Response('Invalid events', { status: 400 });
      if (!body.events.length) return new Response('OK'); // LINE console's Verify button.
      const required = ['DB', 'GEMINI_API_KEY', 'LINE_CHANNEL_ACCESS_TOKEN', 'ALLOWED_LINE_USER_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
      if (required.some(key => !env[key])) return new Response('Configuration incomplete', { status: 503 });
      const work = (async () => {
        for (const event of body.events) {
          try { await handleEvent(event, env, fetcher, clock()); }
          catch (error) {
            // Never log messages, raw upstream errors, URLs or credentials.
            console.error('bot_error', error instanceof BotError ? error.code : 'internal');
            if (event.source?.type === 'user' && event.source?.userId === env.ALLOWED_LINE_USER_ID) {
              try { await reply(env, event.replyToken, [textMessage(error instanceof BotError ? error.message : '処理に失敗しました。設定を確認し、もう一度お試しください。')], fetcher); }
              catch { console.error('bot_error', 'reply-failed'); }
            }
          }
        }
      })();
      if (ctx?.waitUntil) ctx.waitUntil(work);
      return new Response('OK');
    }
  };
}

export default createHandler();
