CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (channel, external_user_id)
);

CREATE TABLE conversations (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  state_json TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE channel_updates (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_update_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  received_at TEXT NOT NULL,
  processing_status TEXT NOT NULL,
  lease_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  UNIQUE (channel, external_update_id)
);

CREATE TABLE channel_messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_chat_id TEXT,
  external_message_id TEXT,
  user_id TEXT REFERENCES users(id),
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL,
  category TEXT,
  content TEXT,
  related_task_id TEXT,
  related_routine_id TEXT,
  delivery_status TEXT,
  error_details TEXT,
  callback_information TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX channel_messages_user_created
  ON channel_messages(user_id, created_at);
CREATE INDEX channel_messages_external_message
  ON channel_messages(channel, external_chat_id, external_message_id);
CREATE UNIQUE INDEX channel_messages_delivery_identity
  ON channel_messages(channel, external_chat_id, external_message_id, direction);

CREATE TABLE channel_actions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  external_action_id TEXT,
  action_identifier TEXT,
  action_name TEXT,
  related_record_id TEXT,
  result TEXT,
  error_details TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (channel, external_action_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  google_task_id TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'Medium',
  area TEXT,
  created_at TEXT,
  due_date TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  postponement_count INTEGER NOT NULL DEFAULT 0,
  last_reminder_at TEXT,
  escalation_status TEXT NOT NULL DEFAULT 'None',
  notes TEXT NOT NULL DEFAULT '',
  source_row INTEGER
);

CREATE INDEX tasks_status_due_date ON tasks(status, due_date);
CREATE INDEX tasks_created_at ON tasks(created_at);

CREATE TABLE task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  previous_status TEXT,
  new_status TEXT,
  previous_due_date TEXT,
  new_due_date TEXT,
  action_type TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_row INTEGER
);

CREATE INDEX task_history_task_time ON task_history(task_id, occurred_at);

CREATE TABLE daily_outcomes (
  id TEXT PRIMARY KEY,
  outcome_date TEXT NOT NULL,
  area TEXT NOT NULL,
  outcome TEXT NOT NULL,
  done_test TEXT NOT NULL DEFAULT '',
  google_task_id TEXT,
  status TEXT NOT NULL,
  calendar_event_id TEXT,
  block_start TEXT,
  block_end TEXT,
  status_details TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  source_row INTEGER
);

CREATE INDEX daily_outcomes_date_area_updated
  ON daily_outcomes(outcome_date, area, updated_at);
CREATE INDEX daily_outcomes_google_task ON daily_outcomes(google_task_id);

CREATE TABLE review_notes (
  id TEXT PRIMARY KEY,
  review_type TEXT NOT NULL,
  review_date TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  related_area TEXT,
  created_at TEXT NOT NULL,
  source_row INTEGER
);

CREATE INDEX review_notes_type_date ON review_notes(review_type, review_date);

CREATE TABLE mini_app_requests (
  id TEXT PRIMARY KEY,
  google_task_id TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error_details TEXT,
  source_row INTEGER
);

CREATE TABLE accountability_routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL,
  scheduled_time TEXT NOT NULL,
  active_status TEXT NOT NULL,
  reminder_configuration TEXT,
  maximum_reminders INTEGER NOT NULL DEFAULT 3,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE accountability_checkins (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES accountability_routines(id),
  activity_date TEXT NOT NULL,
  status TEXT NOT NULL,
  confirmation_method TEXT,
  confirmed_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  postponement_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  tasks_scheduled INTEGER NOT NULL DEFAULT 0,
  source_row INTEGER
);

CREATE INDEX accountability_checkins_routine_date
  ON accountability_checkins(routine_id, activity_date);

CREATE TABLE reminder_history (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  related_record_id TEXT,
  scheduled_at TEXT,
  sent_at TEXT,
  reminder_number INTEGER,
  delivery_status TEXT NOT NULL,
  user_response TEXT,
  confirmed_at TEXT,
  follow_up_scheduled_at TEXT,
  source_row INTEGER
);

CREATE INDEX reminder_history_related_schedule
  ON reminder_history(related_record_id, scheduled_at);
CREATE INDEX reminder_history_status_schedule
  ON reminder_history(delivery_status, scheduled_at);

CREATE TABLE daily_reviews (
  review_date TEXT PRIMARY KEY,
  total_tasks INTEGER,
  completed_tasks INTEGER,
  incomplete_tasks INTEGER,
  postponed_tasks INTEGER,
  overdue_tasks INTEGER,
  planning_completed INTEGER,
  trello_completed INTEGER,
  obsidian_completed INTEGER,
  review_completed INTEGER,
  accountability_score REAL,
  observations TEXT
);

CREATE TABLE weekly_reviews (
  week_starting_date TEXT PRIMARY KEY,
  tasks_created INTEGER,
  tasks_completed INTEGER,
  tasks_overdue INTEGER,
  postponements INTEGER,
  planning_consistency REAL,
  trello_maintenance_rate REAL,
  obsidian_maintenance_rate REAL,
  average_accountability_score REAL,
  repeated_problems TEXT,
  recommendations TEXT
);

CREATE TABLE monthly_reviews (
  month TEXT PRIMARY KEY,
  tasks_created INTEGER,
  tasks_completed INTEGER,
  task_completion_rate REAL,
  tasks_overdue INTEGER,
  postponements INTEGER,
  planning_consistency REAL,
  trello_maintenance_rate REAL,
  obsidian_maintenance_rate REAL,
  average_accountability_score REAL,
  recurring_problems TEXT,
  improvements TEXT,
  recommendations TEXT
);

CREATE TABLE email_escalations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  reason TEXT NOT NULL,
  escalation_level TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  delivery_result TEXT NOT NULL,
  previous_escalations INTEGER NOT NULL DEFAULT 0,
  source_row INTEGER
);

CREATE INDEX email_escalations_task_reason_result
  ON email_escalations(task_id, reason, delivery_result);

CREATE TABLE system_logs (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  severity TEXT NOT NULL,
  component TEXT NOT NULL,
  event_type TEXT NOT NULL,
  description TEXT NOT NULL,
  execution_id TEXT,
  related_record_id TEXT,
  error_message TEXT,
  stack_trace TEXT
);

CREATE INDEX system_logs_severity_time ON system_logs(severity, occurred_at);

CREATE TABLE settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  description TEXT,
  category TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_logs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  operation TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  result TEXT NOT NULL,
  error_details TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  related_record_id TEXT
);

CREATE INDEX sync_logs_source_operation_time
  ON sync_logs(source, operation, occurred_at);

CREATE TABLE scheduled_job_runs (
  id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  error_details TEXT
);
