function toDateKey(value) {
  return value ? String(value).slice(0, 10) : null;
}

function taskStatus(task) {
  if (task.deleted) return "Deleted";
  return task.status === "completed" ? "Completed" : "Pending";
}

export async function syncGoogleTaskMirrors(db, googleTasks, occurredAt) {
  if (!Array.isArray(googleTasks)) throw new TypeError("Google Tasks response must be an array.");
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    throw new TypeError("A valid synchronization timestamp is required.");
  }
  const uniqueTasks = Array.from(new Map(googleTasks.map(task => {
    if (!task || typeof task.id !== "string" || !task.id) {
      throw new TypeError("Google Task ID is required.");
    }
    return [task.id, task];
  })).values());
  const mirrored = [];
  for (let offset = 0; offset < uniqueTasks.length; offset += 50) {
    const chunk = uniqueTasks.slice(offset, offset + 50);
    if (!chunk.length) continue;
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(", ");
    const existingRows = await db.prepare(
      `SELECT id, google_task_id, status, due_date
         FROM tasks
        WHERE google_task_id IN (${placeholders})`
    ).bind(...chunk.map(task => task.id)).all();
    const existingByGoogleId = new Map(
      existingRows.results.map(row => [row.google_task_id, row])
    );
    const statements = [];

    for (const task of chunk) {
      const existing = existingByGoogleId.get(task.id) || null;
      const status = taskStatus(task);
      const dueDate = toDateKey(task.due);
      const taskId = existing ? existing.id : `TASK-${crypto.randomUUID()}`;
      statements.push(buildTaskWrite(db, task, occurredAt, {}, existing, taskId, status, dueDate));
      if (!existing || existing.status !== status || existing.due_date !== dueDate) {
        statements.push(buildTaskHistory(db, taskId, existing, status, dueDate, occurredAt));
      }
      mirrored.push({
        id: taskId,
        googleTaskId: task.id,
        status,
        changed: !existing || existing.status !== status || existing.due_date !== dueDate
      });
    }
    await db.batch(statements);
  }
  return mirrored;
}

export async function upsertGoogleTaskMirror(db, googleTask, occurredAt, metadata = {}) {
  if (!googleTask || typeof googleTask.id !== "string" || !googleTask.id) {
    throw new TypeError("Google Task ID is required.");
  }
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    throw new TypeError("A valid synchronization timestamp is required.");
  }

  const existing = await db.prepare(
    `SELECT id, status, due_date, priority, area, created_at, postponement_count,
            last_reminder_at, escalation_status, notes
       FROM tasks
      WHERE google_task_id = ?1`
  ).bind(googleTask.id).first();

  const status = taskStatus(googleTask);
  const dueDate = toDateKey(googleTask.due);
  const historyChanged = !existing || existing.status !== status || existing.due_date !== dueDate;
  const taskId = existing ? existing.id : `TASK-${crypto.randomUUID()}`;
  const statements = [
    buildTaskWrite(db, googleTask, occurredAt, metadata, existing, taskId, status, dueDate)
  ];
  if (historyChanged) {
    statements.push(buildTaskHistory(db, taskId, existing, status, dueDate, occurredAt));
  }

  await db.batch(statements);
  return { id: taskId, googleTaskId: googleTask.id, status, changed: historyChanged };
}

function buildTaskWrite(db, task, occurredAt, metadata, existing, taskId, status, dueDate) {
  if (existing) {
    return db.prepare(
      `UPDATE tasks
          SET title = ?1,
              description = ?2,
              status = ?3,
              area = COALESCE(?4, area),
              priority = COALESCE(?5, priority),
              due_date = ?6,
              completed_at = ?7,
              updated_at = ?8
        WHERE id = ?9`
    ).bind(
      String(task.title || ""),
      String(task.notes || ""),
      status,
      metadata.area || null,
      metadata.priority || null,
      dueDate,
      status === "Completed" ? (task.completed || null) : null,
      occurredAt,
      taskId
    );
  }
  return db.prepare(
    `INSERT INTO tasks (
       id, google_task_id, title, description, status, priority, area,
       created_at, due_date, completed_at, updated_at, postponement_count,
       last_reminder_at, escalation_status, notes
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?8, 0, NULL, 'None', '')`
  ).bind(
    taskId,
    task.id,
    String(task.title || ""),
    String(task.notes || ""),
    status,
    metadata.priority || "Medium",
    metadata.area || null,
    occurredAt,
    dueDate,
    status === "Completed" ? (task.completed || null) : null
  );
}

function buildTaskHistory(db, taskId, existing, status, dueDate, occurredAt) {
  return db.prepare(
    `INSERT INTO task_history (
       id, task_id, previous_status, new_status, previous_due_date,
       new_due_date, action_type, source, occurred_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Google Tasks', ?8)`
  ).bind(
    `TH-${crypto.randomUUID()}`,
    taskId,
    existing ? existing.status : "",
    status,
    existing ? existing.due_date : null,
    dueDate,
    existing ? "Synchronized" : "Created",
    occurredAt
  );
}

export async function listPendingTaskMirrors(db, today, limit = 8, offset = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today))) {
    throw new TypeError("Today must be a YYYY-MM-DD date key.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(offset) || offset < 0) {
    throw new RangeError("Task list pagination is invalid.");
  }

  const result = await db.prepare(
    `SELECT id, google_task_id, title, description, status, priority, area, due_date
       FROM tasks
      WHERE status = 'Pending'
      ORDER BY
        CASE WHEN due_date IS NOT NULL AND due_date < ?1 THEN 0
             WHEN due_date = ?1 THEN 1
             WHEN due_date > ?1 THEN 2
             ELSE 3 END,
        due_date IS NULL,
        due_date,
        CASE priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
        id
      LIMIT ?2 OFFSET ?3`
  ).bind(today, limit, offset).all();

  return result.results;
}

export async function appendFocusOutcomeStatus(db, outcome, status, details, occurredAt) {
  const allowedStatuses = new Set([
    "In progress", "Completed", "Partial", "Blocked", "Rescheduled", "Dropped"
  ]);
  if (!outcome || !outcome.outcome_date ||
      !["DEEP", "WORK", "LIFE"].includes(outcome.area) ||
      !allowedStatuses.has(status) ||
      !occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    throw new TypeError("Daily outcome status update is invalid.");
  }
  await db.prepare(
    `INSERT INTO daily_outcomes (
       id, outcome_date, area, outcome, done_test, google_task_id, status,
       calendar_event_id, block_start, block_end, status_details, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
  ).bind(
    `OUTCOME-${crypto.randomUUID()}`,
    outcome.outcome_date,
    outcome.area,
    outcome.outcome,
    outcome.done_test || "",
    outcome.google_task_id || null,
    status,
    outcome.calendar_event_id || null,
    outcome.block_start || null,
    outcome.block_end || null,
    details || "",
    occurredAt
  ).run();
}
