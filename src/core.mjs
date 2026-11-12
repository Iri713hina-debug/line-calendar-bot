export class BotError extends Error {
  constructor(code, message) { super(message); this.name = 'BotError'; this.code = code; }
}

export async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function verifySignature(raw, signature, secret) {
  if (!signature || !secret) return false;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(raw));
  } catch { return false; }
}

export function japanDate(now = Date.now()) {
  return new Date(now + 9 * 3600000).toISOString().slice(0, 10);
}

const MEETING_HOST_PATTERN = /(?:^|\.)(?:zoom\.us|zoomgov\.com|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)$/i;

export function isMeetingUrl(url) {
  try { return MEETING_HOST_PATTERN.test(new URL(url).hostname); }
  catch { return false; }
}

// Keep actual links out of AI requests. URLs are never fetched by this application.
export function prepareSource(source) {
  const urls = [];
  let text = source.replace(/https?:\/\/[^\s<>「」『』【】（）]+/giu, match => {
    let clean = match.replace(/[。、，．,.;；）)\]】]+$/u, '');
    try { new URL(clean); } catch { return '[不正なURL]'; }
    let index = urls.indexOf(clean);
    if (index < 0) index = urls.push(clean) - 1;
    return `[URL_${index + 1}]`;
  });
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[メールアドレス]');
  text = text.replace(/(?:0\d{1,4}[-ー ]\d{1,4}[-ー ]\d{3,4}|0\d{9,10})(?!\d)/gu, '[電話番号]');
  const hints = urls.map((u, i) => {
    let host = 'unknown';
    try { host = new URL(u).hostname; } catch {}
    return { hint: `URL_${i + 1}:${host}`, isMeeting: isMeetingUrl(u), index: i };
  });
  // 会議URLを優先しつつ最大20件に制限
  const meetingHints = hints.filter(h => h.isMeeting);
  const otherHints = hints.filter(h => !h.isMeeting);
  const selected = [...meetingHints, ...otherHints].slice(0, 20).sort((a, b) => a.index - b.index);
  const urlHints = selected.map(h => h.hint);
  return { text, urls, urlHints };
}

function bounded(value, max = 200) {
  if (typeof value !== 'string') throw new BotError('format', '案内文を読み取れませんでした。日時を明記して、もう一度送ってください。');
  return value.trim().slice(0, max);
}

export function normalizeJapanTime(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::00)?(\+09:00)$/.exec(value);
  if (!m) return null;
  return `${m[1]}:00${m[2]}`;
}

export function parseJapanTime(value) {
  const normalized = normalizeJapanTime(value);
  if (!normalized) return NaN;
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) return NaN;
  // Reject impossible days such as February 30 rather than allowing JS date rollover.
  const roundtrip = new Date(time + 9 * 3600000).toISOString().replace('Z', '+09:00').replace('.000', '');
  return roundtrip === normalized ? time : NaN;
}

export function validateExtraction(raw, urls, now = Date.now()) {
  if (!raw || typeof raw !== 'object') throw new BotError('format', '案内を読み取れませんでした。');
  if (raw.intent === 'change' || raw.intent === 'cancel') {
    throw new BotError('change', '日程変更・中止の案内です。この初期版では既存予定を変更しません。Googleカレンダーで元の予定を修正・削除してください。');
  }
  if (raw.needsInformation) throw new BotError('missing', `確認が必要です：${bounded(raw.needsInformation, 600)}\n案内文に不足分を追記し、全文を送り直してください。`);
  if (raw.intent !== 'new' || !Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > 3) {
    throw new BotError('missing', '企業名、年月日、開始時刻を含む案内文を送ってください。候補は一度に3件まで読み取れます。');
  }
  return raw.events.map(event => {
    const title = bounded(event.title, 150);
    const startMs = parseJapanTime(event.start);
    if (!title || !Number.isFinite(startMs) || startMs <= now) {
      throw new BotError('date', '開始日時を確認できないか、過去の日付になっています。西暦を含む年月日と開始時刻を追記して送り直してください。');
    }
    const warnings = (Array.isArray(event.warnings) ? event.warnings : []).map(x => bounded(x, 200)).slice(0, 5);
    const endMs = event.end ? parseJapanTime(event.end) : startMs + 3600000;
    if (!Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 24 * 3600000) {
      throw new BotError('date', '終了日時が不正です。開始・終了の年月日と時刻を明記して送り直してください。');
    }
    if (!event.end) warnings.push('終了時刻がないため、所要時間を仮に60分としています。');
    const refs = Array.isArray(event.urlRefs) ? event.urlRefs : [];
    if (refs.length > 5) throw new BotError('url', 'URLが多すぎます。対象の案内と参加用URLだけを送り直してください。');
    const links = [...new Set(refs.map(ref => {
      const m = typeof ref === 'string' && /^URL_([1-9]\d*)$/.exec(ref);
      if (!m || !urls[Number(m[1]) - 1]) throw new BotError('url', 'URLの対応を確認できませんでした。該当する案内だけを送り直してください。');
      return urls[Number(m[1]) - 1];
    }))];
    // Preserve a single original link even when the model omitted its reference.
    if (urls.length === 1 && !links.length) links.push(urls[0]);
    if (urls.length > 1 && !links.length) {
      const meetingUrls = urls.filter(isMeetingUrl);
      if (meetingUrls.length === 1) {
        links.push(meetingUrls[0]);
      } else if (meetingUrls.length > 1) {
        throw new BotError('url', '複数のWeb会議URLがあり、予定との対応を確認できません。参加用URLを明記して送り直してください。');
      }
    }
    return {
      title,
      start: new Date(startMs + 9 * 3600000).toISOString().replace('Z', '+09:00').replace('.000', ''),
      end: new Date(endMs + 9 * 3600000).toISOString().replace('Z', '+09:00').replace('.000', ''),
      location: bounded(event.location || '', 300),
      links,
      warnings
    };
  });
}

export async function eventFingerprint(owner, event) {
  return digest(JSON.stringify([owner, event.title.normalize('NFKC').replace(/\s+/gu, ''), event.start, event.end]));
}

export function formatTime(value) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(value));
}

export function reminderMinutesForPrevDay8pm(start) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):00\+09:00$/.exec(start);
  if (!m) return 1440;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  return 240 + hour * 60 + minute;
}

export function calendarPayload(event, fingerprint) {
  const prevDay8pmMinutes = reminderMinutesForPrevDay8pm(event.start);
  return {
    // Google accepts base32hex characters for client-supplied event IDs; hex is a subset.
    id: fingerprint,
    summary: event.title,
    location: event.location,
    description: [
      'LINEから取り込み、本人が確認して登録した予定です。',
      ...event.links.map((url, i) => `URL ${i + 1}: ${url}`),
      ...event.warnings.map(w => `確認事項: ${w}`)
    ].join('\n'),
    start: { dateTime: event.start, timeZone: 'Asia/Tokyo' },
    end: { dateTime: event.end, timeZone: 'Asia/Tokyo' },
    reminders: { useDefault: false, overrides: [
      { method: 'popup', minutes: prevDay8pmMinutes }, { method: 'popup', minutes: 10 }
    ] },
    extendedProperties: { private: { lineJobCalendarFingerprint: fingerprint } }
  };
}
