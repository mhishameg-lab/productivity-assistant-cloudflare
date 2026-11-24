CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  remind_at_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  ping_count INTEGER NOT NULL DEFAULT 0,
  snooze_count INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL,
  UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS reminders_status_due
  ON reminders(status, remind_at_utc);
