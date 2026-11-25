CREATE TABLE IF NOT EXISTS brainstorms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS brainstorms_user_created
  ON brainstorms(user_id, created_at DESC);

ALTER TABLE tasks ADD COLUMN parent_google_task_id TEXT;
