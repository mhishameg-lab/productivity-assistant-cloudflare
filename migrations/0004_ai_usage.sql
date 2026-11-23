CREATE TABLE ai_usage_daily (
  usage_date_utc TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0,
  reserved_neurons INTEGER NOT NULL DEFAULT 0,
  failed_request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
