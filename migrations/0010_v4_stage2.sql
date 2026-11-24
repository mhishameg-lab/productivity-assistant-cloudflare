CREATE TABLE IF NOT EXISTS companion_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  cairo_date TEXT NOT NULL,
  consecutive_ignored INTEGER NOT NULL DEFAULT 0,
  tier_override_until TEXT,
  last_kind TEXT,
  last_proactive_at TEXT,
  sent_today_count INTEGER NOT NULL DEFAULT 0,
  paused_until TEXT,
  dive_until TEXT,
  awake_until TEXT,
  updated_at TEXT NOT NULL
);
