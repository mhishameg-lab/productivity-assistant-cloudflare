INSERT OR IGNORE INTO settings (setting_key, setting_value, description, category, updated_at)
VALUES
  ('display_name', 'Mohamed', 'Telegram display name', 'Display', '2026-11-23T00:00:00.000Z'),
  ('area_growth_hint', 'Learning that builds my future (HVAC/BIM, Python, automation)', 'Growth area placeholder', 'Display', '2026-11-23T00:00:00.000Z'),
  ('area_work_hint', 'GTMx and SDR work, Upflex prep', 'Work area placeholder', 'Display', '2026-11-23T00:00:00.000Z'),
  ('area_life_hint', 'Health, gym, money, errands', 'Life area placeholder', 'Display', '2026-11-23T00:00:00.000Z'),
  ('pulse_morning_start', '09:00', 'Morning pulse window start', 'Pulses', '2026-11-23T00:00:00.000Z'),
  ('pulse_morning_end', '14:00', 'Morning pulse window end', 'Pulses', '2026-11-23T00:00:00.000Z'),
  ('pulse_shift_start', '15:00', 'Shift pulse window start', 'Pulses', '2026-11-23T00:00:00.000Z'),
  ('pulse_shift_end', '23:00', 'Shift pulse window end', 'Pulses', '2026-11-23T00:00:00.000Z'),
  ('pulse_idle_minutes', '150', 'Idle minutes before a pulse', 'Pulses', '2026-11-23T00:00:00.000Z'),
  ('pulse_max_per_weekday', '3', 'Maximum pulses on a weekday', 'Pulses', '2026-11-23T00:00:00.000Z'),
  ('pulse_nudge_minutes', '15', 'Minutes before a pulse nudge', 'Pulses', '2026-11-23T00:00:00.000Z'),
  ('pulse_care_time', '18:30', 'Workday care note time', 'Pulses', '2026-11-23T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS work_pulses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  cairo_date TEXT NOT NULL,
  slot TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  task_ref TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  response TEXT,
  reason TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,
  UNIQUE (user_id, cairo_date, slot)
);

CREATE TABLE IF NOT EXISTS today_cards (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  cairo_date TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
