CREATE TABLE calendar_blocks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  calendar_request_id TEXT NOT NULL UNIQUE,
  google_event_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (start_at < end_at)
);

CREATE INDEX calendar_blocks_task_start
  ON calendar_blocks(task_id, start_at);
