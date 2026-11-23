CREATE TABLE focus_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT NOT NULL,
  outcome_date TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('DEEP', 'WORK', 'LIFE')),
  google_task_id TEXT,
  next_action TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes IN (25, 50)),
  started_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  followup_status TEXT NOT NULL CHECK (
    followup_status IN ('Scheduled', 'Sending', 'Sent', 'Expired', 'Failed')
  ),
  claim_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  response_status TEXT,
  processing_from_status TEXT,
  response_details TEXT,
  responded_at TEXT
);

CREATE INDEX focus_sessions_due
  ON focus_sessions(followup_status, due_at);
CREATE INDEX focus_sessions_user_started
  ON focus_sessions(user_id, started_at);
