import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createHandler } from '../src/worker.mjs';
import { calendarPayload, eventFingerprint, isMeetingUrl, japanDate, normalizeJapanTime, parseJapanTime, prepareSource, reminderMinutesForPrevDay8pm, validateExtraction, verifySignature } from '../src/core.mjs';

const NOW = Date.parse('2026-11-09T14:00:00Z');
const OWNER = 'U' + 'a'.repeat(32);
const source = '株式会社サンプル 面談 2026年11月20日15:00〜16:00 https://example.com/join?token=PRIVATE test@example.com 090-1234-5678';
const sampleEvent = () => ({ title: '株式会社サンプル 面談', start: '2026-11-20T15:00:00+09:00',
  end: '2026-11-20T16:00:00+09:00', location: 'オンライン', urlRefs: ['URL_1'], warnings: [] });
const extraction = () => ({ intent: 'new', needsInformation: '', events: [sampleEvent()] });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Exercise the actual SQL schema/queries through SQLite, not an in-memory imitation of state changes.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return { sqlite, prepare(sql) {
    const query = sqlite.prepare(sql);
    const wrap = args => ({
      bind: (...values) => wrap(values),
      first: async () => query.get(...args) || null,
      run: async () => ({ meta: { changes: Number(query.run(...args).changes) } })
    });
    return wrap([]);
  } };
}

function fixture(options = {}) {
  const DB = database();
  const calls = [], replies = [], inserted = new Map();
  const env = { DB, LINE_CHANNEL_SECRET: 'test-signature-secret', LINE_CHANNEL_ACCESS_TOKEN: 'test-line',
    ALLOWED_LINE_USER_ID: OWNER, GEMINI_API_KEY: 'test-key', GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-client-secret', GOOGLE_REFRESH_TOKEN: 'test-refresh', DAILY_AI_LIMIT: '20' };
  let failInsert = options.failInsertOnce;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('generativelanguage.googleapis.com')) return options.aiStatus ? json({}, options.aiStatus) : json({
      candidates: [{ content: { parts: [{ text: JSON.stringify(options.extraction || extraction()) }] } }]
    });
    if (url === 'https://api.line.me/v2/bot/message/reply') {
      replies.push(JSON.parse(init.body)); return json({});
    }
    if (url === 'https://oauth2.googleapis.com/token') return options.authFailure ? json({}, 400) : json({ access_token: 'test-access' });
    if (url.includes('www.googleapis.com/calendar/v3')) {
      const eventId = url.split('/').at(-1).split('?')[0];
      if (init.method === 'POST') {
        const payload = JSON.parse(init.body);
        if (inserted.has(payload.id)) return json({}, 409);
        const value = { ...payload, status: 'confirmed', htmlLink: 'https://calendar.google.com/calendar/event?eid=test' };
        inserted.set(payload.id, value);
        if (failInsert) { failInsert = false; throw new Error('timeout after commit'); }
        return json(value);
      }
      if (init.method === 'PUT') {
        const payload = JSON.parse(init.body);
        const value = { ...payload, htmlLink: 'https://calendar.google.com/calendar/event?eid=test' };
        inserted.set(eventId, value);
        return json(value);
      }
      return inserted.has(eventId) ? json(inserted.get(eventId)) : json({}, 404);
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const handler = createHandler(fetcher, () => options.now || NOW);
  async function webhook(events, badSignature = false) {
    const raw = JSON.stringify({ events });
    const signature = createHmac('sha256', env.LINE_CHANNEL_SECRET).update(raw).digest('base64');
    const work = [];
    const response = await handler.fetch(new Request('https://bot.example/webhook', {
      method: 'POST', body: raw, headers: { 'x-line-signature': badSignature ? 'invalid' : signature }
    }), env, { waitUntil: promise => work.push(promise) });
    await Promise.all(work);
    return response;
  }
  return { env, calls, replies, inserted, webhook,
    getDraft: () => DB.sqlite.prepare('SELECT * FROM drafts ORDER BY created_at DESC LIMIT 1').get() };
}

function message(id = 'm1', text = source, user = OWNER) {
  return { type: 'message', webhookEventId: `evt-${id}`, replyToken: `reply-${id}`, source: { type: 'user', userId: user }, message: { type: 'text', id, text } };
}
function postback(id, action = 'confirm') {
  return { type: 'postback', webhookEventId: crypto.randomUUID(), replyToken: crypto.randomUUID(), source: { type: 'user', userId: OWNER }, postback: { data: `${action}:${id}` } };
}

test('signature verification accepts only unchanged signed bodies', async () => {
  const raw = '{"events":[]}';
  const signature = createHmac('sha256', 'secret').update(raw).digest('base64');
  assert.equal(await verifySignature(raw, signature, 'secret'), true);
  assert.equal(await verifySignature(raw + ' ', signature, 'secret'), false);
  assert.equal(await verifySignature(raw, 'garbage', 'secret'), false);
});

test('URL and common contact details do not enter the AI prompt', () => {
  const result = prepareSource(source);
  assert.equal(result.urls[0], 'https://example.com/join?token=PRIVATE');
  assert.match(result.text, /\[URL_1\]/);
  assert.doesNotMatch(result.text, /PRIVATE|test@example|090-1234/);
});

test('reject impossible dates, missing times, and changes instead of creating events', () => {
  assert.throws(() => validateExtraction({ ...extraction(), events: [{ ...sampleEvent(), start: '2027-02-30T15:00:00+09:00' }] }, ['https://example.com'], NOW));
  assert.throws(() => validateExtraction({ ...extraction(), needsInformation: '開始時刻は？' }, [], NOW), /開始時刻/);
  assert.throws(() => validateExtraction({ ...extraction(), intent: 'change' }, [], NOW), /変更/);
});

test('missing end gets a visible 60-minute assumption, unknown URL refs are rejected', () => {
  const [e] = validateExtraction({ ...extraction(), events: [{ ...sampleEvent(), end: '' }] }, ['https://example.com'], NOW);
  assert.equal(e.end, '2026-11-20T16:00:00+09:00');
  assert.match(e.warnings.join(''), /60分/);
  assert.throws(() => validateExtraction(extraction(), [], NOW), /URL/);
});

test('Japan day rolls over at 15:00 UTC; payload has two reminders and original URLs', () => {
  assert.equal(japanDate(Date.parse('2026-11-09T15:00:00Z')), '2026-11-10');
  const [e] = validateExtraction(extraction(), ['https://example.com/join?secret=x'], NOW);
  const payload = calendarPayload(e, 'abc');
  // 15:00 start: 240 + 15*60 + 0 = 1140 minutes before (= prev day 20:00)
  assert.deepEqual(payload.reminders.overrides.map(x => x.minutes), [1140, 10]);
  assert.match(payload.description, /secret=x/);
  assert.equal(payload.attendees, undefined);

  // 10:30 start: 240 + 10*60 + 30 = 870 minutes before (= prev day 20:00)
  const e1030 = { ...e, start: '2026-11-20T10:30:00+09:00', end: '2026-11-20T11:30:00+09:00' };
  const payload1030 = calendarPayload(e1030, 'xyz');
  assert.deepEqual(payload1030.reminders.overrides.map(x => x.minutes), [870, 10]);

  // reminderMinutesForPrevDay8pm helper
  assert.equal(reminderMinutesForPrevDay8pm('2026-11-20T09:00:00+09:00'), 780);
  assert.equal(reminderMinutesForPrevDay8pm('2026-11-20T20:00:00+09:00'), 1440);
});

test('no Calendar calls before explicit confirmation; candidate has persistent buttons', async () => {
  const f = fixture();
  assert.equal((await f.webhook([message()])).status, 200);
  assert.equal(f.inserted.size, 0);
  assert.equal(f.getDraft().status, 'pending');
  const card = f.replies.at(-1).messages.find(m => m.type === 'flex');
  assert.equal(card.contents.footer.contents[0].action.data, `confirm:${f.getDraft().id}`);
  const prompt = f.calls.find(c => c.url.includes('generativelanguage')).init.body;
  assert.doesNotMatch(prompt, /PRIVATE|test@example/);
});

test('confirm creates one calendar event; repeated and concurrent clicks cannot duplicate it', async () => {
  const f = fixture();
  await f.webhook([message()]);
  const id = f.getDraft().id;
  await Promise.all([f.webhook([postback(id)]), f.webhook([postback(id)])]);
  await f.webhook([postback(id)]);
  assert.equal(f.inserted.size, 1);
  assert.equal(f.getDraft().status, 'created');
  const value = [...f.inserted.values()][0];
  assert.match(value.description, /https:\/\/example.com\/join\?token=PRIVATE/);
  assert.equal(value.start.timeZone, 'Asia/Tokyo');
});

test('timeout after Google commit is recoverable with deterministic ID and a 409 lookup', async () => {
  const f = fixture({ failInsertOnce: true });
  await f.webhook([message()]);
  const id = f.getDraft().id;
  await f.webhook([postback(id)]);
  assert.equal(f.getDraft().status, 'pending');
  assert.equal(f.inserted.size, 1);
  await f.webhook([postback(id)]);
  assert.equal(f.inserted.size, 1);
  assert.equal(f.getDraft().status, 'created');
  assert.ok(f.calls.some(c => c.url.includes('/events/') && c.init.method !== 'POST'));
});

test('invalid signature and another user cannot spend AI quota or create drafts', async () => {
  const f = fixture();
  assert.equal((await f.webhook([message()], true)).status, 401);
  await f.webhook([message('other', source, 'U' + 'b'.repeat(32))]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.getDraft(), undefined);
});

test('groups and forged draft ownership are ignored', async () => {
  const f = fixture();
  const group = message(); group.source.type = 'group';
  await f.webhook([group]);
  assert.equal(f.calls.length, 0);
  await f.webhook([message()]);
  const id = f.getDraft().id;
  f.env.DB.sqlite.prepare('UPDATE drafts SET owner = ? WHERE id = ?').run('another-user', id);
  await f.webhook([postback(id)]);
  assert.equal(f.inserted.size, 0);
});

test('webhook redelivery cannot invoke AI a second time', async () => {
  const f = fixture();
  await f.webhook([message()]); await f.webhook([message()]);
  assert.equal(f.calls.filter(c => c.url.includes('generativelanguage')).length, 1);
});

test('daily app limit blocks new AI calls but still permits confirmation', async () => {
  const f = fixture(); f.env.DAILY_AI_LIMIT = '1';
  await f.webhook([message()]);
  await f.webhook([message('m2')]);
  assert.match(f.replies.at(-1).messages[0].text, /本日の読み取り上限/);
  assert.equal(f.calls.filter(c => c.url.includes('generativelanguage')).length, 1);
  await f.webhook([postback(f.getDraft().id)]);
  assert.equal(f.inserted.size, 1);
});

test('cancel and expired drafts never create Calendar events', async () => {
  const f = fixture(); await f.webhook([message()]);
  const id = f.getDraft().id;
  await f.webhook([postback(id, 'cancel')]);
  await f.webhook([postback(id)]);
  assert.equal(f.inserted.size, 0);
  f.env.DB.sqlite.prepare("UPDATE drafts SET status = 'pending', expires_at = ? WHERE id = ?").run(NOW - 1, id);
  await f.webhook([postback(id)]);
  assert.equal(f.inserted.size, 0);
});

test('Calendar auth failure preserves a candidate for retry', async () => {
  const f = fixture({ authFailure: true }); await f.webhook([message()]);
  await f.webhook([postback(f.getDraft().id)]);
  assert.equal(f.inserted.size, 0);
  assert.equal(f.getDraft().status, 'pending');
  assert.match(f.replies.at(-1).messages[0].text, /リフレッシュトークン/);
});

test('AI quota exhaustion and missing data produce no drafts', async () => {
  for (const options of [{ aiStatus: 429 }, { extraction: { ...extraction(), needsInformation: '年月日を確認してください' } }]) {
    const f = fixture(options); await f.webhook([message()]);
    assert.equal(f.getDraft(), undefined);
    assert.equal(f.inserted.size, 0);
    assert.equal(f.replies.at(-1).messages[0].type, 'text');
  }
});

test('three candidate dates get three independent confirmation cards', async () => {
  const raw = extraction();
  raw.events = [20, 21, 22].map(day => ({ ...sampleEvent(), start: `2026-11-${day}T15:00:00+09:00`, end: `2026-11-${day}T16:00:00+09:00` }));
  const f = fixture({ extraction: raw }); await f.webhook([message()]);
  const cards = f.replies.at(-1).messages.filter(m => m.type === 'flex');
  assert.equal(cards.length, 3);
  const chosen = cards[1].contents.footer.contents[0].action.data.split(':')[1];
  await f.webhook([postback(chosen)]);
  assert.equal(f.inserted.size, 1);
  assert.match([...f.inserted.values()][0].start.dateTime, /11-21/);
});

test('webhook Verify works with zero events before the other credentials are set', async () => {
  const f = fixture(); delete f.env.GEMINI_API_KEY;
  assert.equal((await f.webhook([])).status, 200);
  assert.equal((await f.webhook([message()])).status, 503);
});

test('fingerprint ignores whitespace in title but distinguishes dates and owners', async () => {
  const e = { ...sampleEvent(), links: [] };
  assert.equal(await eventFingerprint(OWNER, e), await eventFingerprint(OWNER, { ...e, title: '株式会社サンプル面談' }));
  assert.notEqual(await eventFingerprint(OWNER, e), await eventFingerprint('someone', e));
});

test('pending draft is overwritten with latest event details when same message is resent', async () => {
  const currentExtraction = extraction();
  const f = fixture({ extraction: currentExtraction });
  await f.webhook([message('m1')]);
  let draft = f.getDraft();
  assert.equal(draft.status, 'pending');
  assert.equal(JSON.parse(draft.event_json).location, 'オンライン');

  // Update extraction to simulate resending announcement with updated location
  currentExtraction.events = [{ ...sampleEvent(), location: '東京本社5F' }];
  await f.webhook([message('m2')]);
  draft = f.getDraft();
  assert.equal(draft.status, 'pending');
  assert.equal(JSON.parse(draft.event_json).location, '東京本社5F');

  // Confirming registers the updated location to Google Calendar
  await f.webhook([postback(draft.id)]);
  assert.equal(f.inserted.size, 1);
  assert.equal([...f.inserted.values()][0].location, '東京本社5F');
});

test('recovering cancelled event in Google Calendar restores with confirmed status via PUT', async () => {
  const f = fixture();
  await f.webhook([message('m1')]);
  const draftId = f.getDraft().id;
  await f.webhook([postback(draftId)]);
  assert.equal(f.inserted.size, 1);
  const eventId = [...f.inserted.keys()][0];
  assert.equal(f.inserted.get(eventId).status, 'confirmed');

  // Simulate event deleted directly in Google Calendar (status becomes 'cancelled')
  f.inserted.get(eventId).status = 'cancelled';

  // Mark draft as pending again (e.g. user resent announcement)
  f.env.DB.sqlite.prepare("UPDATE drafts SET status = 'pending' WHERE id = ?").run(draftId);

  // Confirming again triggers 409 -> GET -> status: 'cancelled' -> PUT with confirmed
  await f.webhook([postback(draftId)]);
  assert.equal(f.inserted.get(eventId).status, 'confirmed');
  assert.match(f.replies.at(-1).messages[0].text, /登録しました/);

  // If another event with mismatched fingerprint is cancelled, throw conflict error
  f.inserted.get(eventId).status = 'cancelled';
  f.inserted.get(eventId).extendedProperties = { private: { lineJobCalendarFingerprint: 'different-fingerprint' } };
  f.env.DB.sqlite.prepare("UPDATE drafts SET status = 'pending' WHERE id = ?").run(draftId);
  await f.webhook([postback(draftId)]);
  assert.match(f.replies.at(-1).messages[0].text, /同じ予定が削除済みか、登録内容の確認が必要です/);
});

test('flexible Japan time parsing accepts missing seconds and normalizes format', () => {
  // normalizeJapanTime helper
  assert.equal(normalizeJapanTime('2026-11-20T15:00+09:00'), '2026-11-20T15:00:00+09:00');
  assert.equal(normalizeJapanTime('2026-11-20T15:00:00+09:00'), '2026-11-20T15:00:00+09:00');
  assert.equal(normalizeJapanTime('invalid'), null);

  // parseJapanTime accepts missing seconds
  assert.ok(Number.isFinite(parseJapanTime('2026-11-20T15:00+09:00')));
  assert.equal(parseJapanTime('2026-11-20T15:00+09:00'), parseJapanTime('2026-11-20T15:00:00+09:00'));

  // validateExtraction normalizes start to :00+09:00
  const raw = {
    intent: 'new',
    needsInformation: '',
    events: [{
      ...sampleEvent(),
      start: '2026-11-20T15:00+09:00',
      end: '2026-11-20T16:00+09:00'
    }]
  };
  const validated = validateExtraction(raw, ['https://example.com'], NOW);
  assert.equal(validated[0].start, '2026-11-20T15:00:00+09:00');
  assert.equal(validated[0].end, '2026-11-20T16:00:00+09:00');

  // Impossible dates are still rejected with missing seconds
  assert.throws(
    () => validateExtraction({ ...raw, events: [{ ...sampleEvent(), start: '2027-02-30T15:00+09:00' }] }, ['https://example.com'], NOW),
    /開始日時/
  );
});

test('multiple URLs: extract only meeting URL, exclude company HP/mypage, and auto-fallback', async () => {
  const multiUrlSource = [
    '株式会社テスト 面談のご案内',
    '日時：2026年11月25日 14:00〜15:00',
    '当日の参加URL：https://us02web.zoom.us/j/123456789?pwd=SECRET_TOKEN',
    'マイページ：https://mypage.example.co.jp/login',
    '企業HP：https://www.example.co.jp/about'
  ].join('\n');

  // 1. prepareSource generates urlHints with hostnames
  const prepared = prepareSource(multiUrlSource);
  assert.equal(prepared.urls.length, 3);
  assert.deepEqual(prepared.urlHints, [
    'URL_1:us02web.zoom.us',
    'URL_2:mypage.example.co.jp',
    'URL_3:www.example.co.jp'
  ]);
  assert.match(prepared.text, /\[URL_1\]/);
  assert.match(prepared.text, /\[URL_2\]/);
  assert.match(prepared.text, /\[URL_3\]/);
  assert.doesNotMatch(prepared.text, /SECRET_TOKEN/);

  // 2. isMeetingUrl correctly identifies meeting domains
  assert.equal(isMeetingUrl('https://us02web.zoom.us/j/123'), true);
  assert.equal(isMeetingUrl('https://meet.google.com/abc-defg-hij'), true);
  assert.equal(isMeetingUrl('https://teams.microsoft.com/l/meetup-join/123'), true);
  assert.equal(isMeetingUrl('https://example.webex.com/meet/test'), true);
  assert.equal(isMeetingUrl('https://mypage.example.co.jp/login'), false);
  assert.equal(isMeetingUrl('https://www.example.co.jp'), false);

  // 3. validateExtraction selects only meeting URL when AI picks URL_1
  const rawWithMeeting = {
    intent: 'new',
    needsInformation: '',
    events: [{
      ...sampleEvent(),
      title: '株式会社テスト 面談',
      start: '2026-11-25T14:00:00+09:00',
      end: '2026-11-25T15:00:00+09:00',
      urlRefs: ['URL_1'] // AI strictly picked only Zoom
    }]
  };
  const [validated] = validateExtraction(rawWithMeeting, prepared.urls, NOW);
  assert.equal(validated.links.length, 1);
  assert.equal(validated.links[0], 'https://us02web.zoom.us/j/123456789?pwd=SECRET_TOKEN');

  // 4. validateExtraction auto-detects single meeting URL even if AI omitted urlRefs
  const rawWithoutRefs = {
    intent: 'new',
    needsInformation: '',
    events: [{
      ...sampleEvent(),
      urlRefs: [] // AI omitted refs
    }]
  };
  const [autoValidated] = validateExtraction(rawWithoutRefs, prepared.urls, NOW);
  assert.equal(autoValidated.links.length, 1);
  assert.equal(autoValidated.links[0], 'https://us02web.zoom.us/j/123456789?pwd=SECRET_TOKEN');

  // 5. In-person interview with no meeting URLs allows empty links without error
  const nonMeetingUrls = ['https://www.example.co.jp/about', 'https://maps.google.com/?q=tokyo'];
  const [inPerson] = validateExtraction(rawWithoutRefs, nonMeetingUrls, NOW);
  assert.deepEqual(inPerson.links, []);

  // 6. Multiple ambiguous meeting URLs throws BotError
  const multiMeetingUrls = ['https://zoom.us/j/1', 'https://meet.google.com/abc'];
  assert.throws(
    () => validateExtraction(rawWithoutRefs, multiMeetingUrls, NOW),
    /複数のWeb会議URLがあり/
  );

  // 7. Full webhook workflow test with multiple URLs: only meeting URL is registered to Calendar
  const f = fixture({
    extraction: {
      intent: 'new',
      needsInformation: '',
      events: [{
        ...sampleEvent(),
        title: '株式会社テスト 面談',
        urlRefs: ['URL_1']
      }]
    }
  });
  await f.webhook([message('m_multi', multiUrlSource)]);
  const draft = f.getDraft();
  assert.equal(JSON.parse(draft.event_json).links.length, 1);
  assert.equal(JSON.parse(draft.event_json).links[0], 'https://us02web.zoom.us/j/123456789?pwd=SECRET_TOKEN');
  await f.webhook([postback(draft.id)]);
  assert.equal(f.inserted.size, 1);
  const calEvent = [...f.inserted.values()][0];
  assert.match(calEvent.description, /https:\/\/us02web\.zoom\.us\/j\/123456789\?pwd=SECRET_TOKEN/);
  assert.doesNotMatch(calEvent.description, /mypage\.example|www\.example/);
});

test('primary model failure automatically falls back to secondary model within budget', async () => {
  let primaryCalled = false;
  let fallbackCalled = false;
  const f = fixture();
  const customFetcher = async (url, init) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      if (url.includes('gemini-3.1-flash-lite')) {
        primaryCalled = true;
        return new Response('Internal Server Error', { status: 500 });
      }
      if (url.includes('gemini-2.5-flash')) {
        fallbackCalled = true;
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(extraction()) }] } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('Not found', { status: 404 });
  };
  const { extract } = await import('../src/services.mjs');
  const events = await extract(f.env, prepareSource(source), customFetcher, NOW);
  assert.equal(primaryCalled, true);
  assert.equal(fallbackCalled, true);
  assert.equal(events.length, 1);
});
