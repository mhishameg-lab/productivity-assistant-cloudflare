CREATE TABLE ai_recommendations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  recommendation_date TEXT NOT NULL,
  recommendation_type TEXT NOT NULL CHECK (recommendation_type = 'daily_focus'),
  task_ids_json TEXT NOT NULL CHECK (json_valid(task_ids_json)),
  generated_at TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'Pending'
    CHECK (decision IN ('Pending', 'Accepted', 'Rejected')),
  decided_at TEXT,
  UNIQUE (user_id, recommendation_date, recommendation_type)
);

CREATE INDEX ai_recommendations_user_date
  ON ai_recommendations(user_id, recommendation_date);
