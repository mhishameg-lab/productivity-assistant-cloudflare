CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  parent_goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  level TEXT NOT NULL CHECK (level IN ('life_vision', 'annual', 'quarterly', 'monthly', 'weekly')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  why_matters TEXT NOT NULL,
  target_outcome TEXT NOT NULL,
  start_date TEXT NOT NULL,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Paused', 'Achieved', 'Archived')),
  next_action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_goal_id IS NULL OR parent_goal_id != id),
  CHECK (deadline IS NULL OR deadline >= start_date)
);

CREATE INDEX goals_user_status_level_deadline
  ON goals(user_id, status, level, deadline);
CREATE INDEX goals_parent_goal
  ON goals(parent_goal_id);

CREATE TABLE goal_key_results (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  title TEXT NOT NULL,
  baseline_value REAL NOT NULL,
  current_value REAL NOT NULL,
  target_value REAL NOT NULL,
  unit TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (target_value != baseline_value)
);

CREATE INDEX goal_key_results_goal
  ON goal_key_results(goal_id);

CREATE TABLE goal_key_result_history (
  id TEXT PRIMARY KEY,
  key_result_id TEXT NOT NULL REFERENCES goal_key_results(id),
  previous_value REAL,
  current_value REAL NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX goal_key_result_history_time
  ON goal_key_result_history(key_result_id, recorded_at);

CREATE TRIGGER goal_key_result_initial_history
AFTER INSERT ON goal_key_results
BEGIN
  INSERT INTO goal_key_result_history (
    id, key_result_id, previous_value, current_value, recorded_at
  ) VALUES (
    'GKRH-' || lower(hex(randomblob(16))),
    NEW.id,
    NULL,
    NEW.current_value,
    NEW.created_at
  );
END;

CREATE TRIGGER goal_key_result_progress_history
AFTER UPDATE OF current_value ON goal_key_results
WHEN OLD.current_value IS NOT NEW.current_value
BEGIN
  INSERT INTO goal_key_result_history (
    id, key_result_id, previous_value, current_value, recorded_at
  ) VALUES (
    'GKRH-' || lower(hex(randomblob(16))),
    NEW.id,
    OLD.current_value,
    NEW.current_value,
    NEW.updated_at
  );
END;

CREATE TABLE goal_projects (
  goal_id TEXT NOT NULL REFERENCES goals(id),
  project_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (goal_id, project_name)
);

CREATE TABLE goal_task_links (
  goal_id TEXT NOT NULL REFERENCES goals(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (goal_id, task_id)
);

CREATE INDEX goal_task_links_task
  ON goal_task_links(task_id);
