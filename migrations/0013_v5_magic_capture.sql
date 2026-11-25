CREATE TABLE IF NOT EXISTS capture_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS capture_drafts_user_expires
  ON capture_drafts(user_id, expires_at);

CREATE TABLE IF NOT EXISTS chat_turns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_turns_user_created
  ON chat_turns(user_id, created_at);

INSERT OR IGNORE INTO settings (setting_key, setting_value, description, category, updated_at)
VALUES (
  'area_keyword_map',
  '{"WORK":["sdr","gtmx","upflex","outreach","call"],"DEEP":["python","hvac","revit","study","learn","course"],"LIFE":["gym","health","bills","bill","pay","passport"]}',
  'Keyword map for deterministic task area guessing',
  'Capture',
  '2026-11-25T00:00:00.000Z'
);
