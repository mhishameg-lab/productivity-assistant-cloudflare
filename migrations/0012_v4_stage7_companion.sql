CREATE TABLE IF NOT EXISTS sleep_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL,
  wake_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  wake_sent_count INTEGER NOT NULL DEFAULT 0,
  last_wake_sent_at TEXT,
  acked_at TEXT
);

CREATE TABLE IF NOT EXISTS checkin_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sent_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  tier TEXT NOT NULL,
  task_ref TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  response TEXT
);

INSERT OR IGNORE INTO settings (setting_key, setting_value, description, category, updated_at)
VALUES
  ('checkin_minutes', '30', 'Outside-shift check-in interval', 'Companion', '2026-11-24T00:00:00.000Z'),
  ('checkin_minutes_shift', '60', 'Shift check-in interval', 'Companion', '2026-11-24T00:00:00.000Z'),
  ('shift_start', '15:00', 'Workday shift start', 'Companion', '2026-11-24T00:00:00.000Z'),
  ('shift_end', '23:00', 'Workday shift end', 'Companion', '2026-11-24T00:00:00.000Z'),
  ('quiet_start', '00:30', 'Quiet hours start', 'Companion', '2026-11-24T00:00:00.000Z'),
  ('quiet_end', '08:00', 'Quiet hours end', 'Companion', '2026-11-24T00:00:00.000Z'),
  ('daily_checkin_cap', '18', 'Maximum daily check-ins', 'Companion', '2026-11-24T00:00:00.000Z'),
  ('answered_window_minutes', '20', 'Answer window', 'Companion', '2026-11-24T00:00:00.000Z');
