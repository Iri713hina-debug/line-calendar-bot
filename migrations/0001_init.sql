CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  calendar_link TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_usage (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
