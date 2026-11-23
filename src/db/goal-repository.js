const PARENT_LEVEL_BY_CHILD_LEVEL = Object.freeze({
  annual: "life_vision",
  quarterly: "annual",
  monthly: "quarterly",
  weekly: "monthly"
});

export async function listGoals(db, userId) {
  const rows = await db.prepare(
    `SELECT g.id, g.parent_goal_id, g.level, g.title, g.category, g.deadline,
            g.status, g.next_action, p.title AS parent_title,
            COUNT(kr.id) AS key_result_count,
            AVG(
              CASE
                WHEN kr.id IS NULL THEN NULL
                WHEN kr.target_value > kr.baseline_value THEN
                  MIN(1.0, MAX(0.0,
                    (kr.current_value - kr.baseline_value) /
                    (kr.target_value - kr.baseline_value)
                  ))
                ELSE
                  MIN(1.0, MAX(0.0,
                    (kr.baseline_value - kr.current_value) /
                    (kr.baseline_value - kr.target_value)
                  ))
              END
            ) AS progress_fraction
       FROM goals g
       LEFT JOIN goals p ON p.id = g.parent_goal_id
       LEFT JOIN goal_key_results kr ON kr.goal_id = g.id
      WHERE g.user_id = ?1
        AND g.status IN ('Active', 'Paused')
      GROUP BY g.id
      ORDER BY CASE g.level
        WHEN 'life_vision' THEN 0
        WHEN 'annual' THEN 1
        WHEN 'quarterly' THEN 2
        WHEN 'monthly' THEN 3
        ELSE 4
      END, g.deadline IS NULL, g.deadline, g.created_at`
  ).bind(userId).all();
  return rows.results;
}

export async function listDailyGoalFocus(db, userId, date, limit = 3) {
  const rows = await db.prepare(
    `SELECT g.id, g.level, g.title, g.deadline, g.next_action,
            p.title AS parent_title,
            AVG(
              CASE
                WHEN kr.id IS NULL THEN NULL
                WHEN kr.target_value > kr.baseline_value THEN
                  MIN(1.0, MAX(0.0,
                    (kr.current_value - kr.baseline_value) /
                    (kr.target_value - kr.baseline_value)
                  ))
                ELSE
                  MIN(1.0, MAX(0.0,
                    (kr.baseline_value - kr.current_value) /
                    (kr.baseline_value - kr.target_value)
                  ))
              END
            ) AS progress_fraction,
            (
              SELECT t.title
                FROM goal_task_links l
                JOIN tasks t ON t.id = l.task_id
               WHERE l.goal_id = g.id AND t.status = 'Pending'
               ORDER BY CASE
                 WHEN t.due_date < ?2 THEN 0
                 WHEN t.due_date = ?2 THEN 1
                 ELSE 2
               END,
               CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
               t.due_date IS NULL, t.due_date, t.title
               LIMIT 1
            ) AS linked_task_title
       FROM goals g
       LEFT JOIN goals p ON p.id = g.parent_goal_id
       LEFT JOIN goal_key_results kr ON kr.goal_id = g.id
      WHERE g.user_id = ?1 AND g.status = 'Active'
      GROUP BY g.id
      ORDER BY CASE
        WHEN g.deadline IS NOT NULL AND g.deadline < ?2 THEN 0
        WHEN g.deadline = ?2 THEN 1
        WHEN g.deadline IS NOT NULL THEN 2
        ELSE 3
      END, g.deadline, CASE g.level
        WHEN 'life_vision' THEN 0
        WHEN 'annual' THEN 1
        WHEN 'quarterly' THEN 2
        WHEN 'monthly' THEN 3
        ELSE 4
      END, g.created_at
      LIMIT ?3`
  ).bind(userId, date, limit).all();
  return rows.results;
}

export async function listGoalParents(db, userId, childLevel) {
  const parentLevel = PARENT_LEVEL_BY_CHILD_LEVEL[childLevel];
  if (!parentLevel) return [];
  const rows = await db.prepare(
    `SELECT id, title, level
       FROM goals
      WHERE user_id = ?1
        AND level = ?2
        AND status = 'Active'
      ORDER BY deadline IS NULL, deadline, created_at
      LIMIT 5`
  ).bind(userId, parentLevel).all();
  return rows.results;
}

export async function getGoal(db, userId, goalId) {
  return db.prepare(
    `SELECT g.id, g.parent_goal_id, g.level, g.title, g.description, g.category,
            g.why_matters, g.target_outcome, g.start_date, g.deadline, g.status,
            g.next_action, g.created_at, g.updated_at, p.title AS parent_title,
            AVG(
              CASE
                WHEN kr.id IS NULL THEN NULL
                WHEN kr.target_value > kr.baseline_value THEN
                  MIN(1.0, MAX(0.0,
                    (kr.current_value - kr.baseline_value) /
                    (kr.target_value - kr.baseline_value)
                  ))
                ELSE
                  MIN(1.0, MAX(0.0,
                    (kr.baseline_value - kr.current_value) /
                    (kr.baseline_value - kr.target_value)
                  ))
              END
            ) AS progress_fraction
       FROM goals g
       LEFT JOIN goals p ON p.id = g.parent_goal_id
       LEFT JOIN goal_key_results kr ON kr.goal_id = g.id
      WHERE g.user_id = ?1 AND g.id = ?2
      GROUP BY g.id`
  ).bind(userId, goalId).first();
}

export async function getGoalKeyResults(db, goalId) {
  const rows = await db.prepare(
    `SELECT id, title, baseline_value, current_value, target_value, unit
       FROM goal_key_results
      WHERE goal_id = ?1
      ORDER BY created_at, id`
  ).bind(goalId).all();
  return rows.results;
}

export async function getGoalKeyResult(db, userId, keyResultId) {
  return db.prepare(
    `SELECT kr.id, kr.goal_id, kr.title, kr.current_value, kr.target_value,
            kr.unit, g.status
       FROM goal_key_results kr
       JOIN goals g ON g.id = kr.goal_id
      WHERE g.user_id = ?1 AND kr.id = ?2`
  ).bind(userId, keyResultId).first();
}

export async function getGoalProjects(db, goalId) {
  const rows = await db.prepare(
    `SELECT project_name
       FROM goal_projects
      WHERE goal_id = ?1
      ORDER BY project_name`
  ).bind(goalId).all();
  return rows.results.map(row => row.project_name);
}

export async function getGoalTaskLinks(db, userId, goalId) {
  const rows = await db.prepare(
    `SELECT t.id, t.title, t.status, t.due_date
       FROM goal_task_links l
       JOIN goals g ON g.id = l.goal_id
       JOIN tasks t ON t.id = l.task_id
      WHERE g.user_id = ?1 AND g.id = ?2
      ORDER BY t.due_date IS NULL, t.due_date, t.title`
  ).bind(userId, goalId).all();
  return rows.results;
}

export async function linkGoalTask(db, userId, goalId, taskId, linkedAt) {
  await db.prepare(
    `INSERT INTO goal_task_links (goal_id, task_id, linked_at)
     SELECT ?1, ?2, ?3
      WHERE EXISTS (
        SELECT 1 FROM goals
         WHERE id = ?1 AND user_id = ?4 AND status = 'Active'
      )
        AND EXISTS (
          SELECT 1 FROM tasks
           WHERE id = ?2 AND status = 'Pending'
        )
     ON CONFLICT(goal_id, task_id) DO NOTHING`
  ).bind(goalId, taskId, linkedAt, userId).run();
  return db.prepare(
    `SELECT 1 AS linked
       FROM goal_task_links l
       JOIN goals g ON g.id = l.goal_id
       JOIN tasks t ON t.id = l.task_id
      WHERE g.user_id = ?1 AND l.goal_id = ?2
        AND l.task_id = ?3 AND t.status = 'Pending'`
  ).bind(userId, goalId, taskId).first();
}

export async function createGoal(db, userId, goal, occurredAt) {
  validateGoal(goal);
  if (goal.parentGoalId) {
    const expectedParentLevel = PARENT_LEVEL_BY_CHILD_LEVEL[goal.level];
    if (!expectedParentLevel) {
      throw new TypeError("Life vision goals cannot have a parent objective.");
    }
    const parent = await db.prepare(
      `SELECT level, status
         FROM goals
        WHERE id = ?1 AND user_id = ?2`
    ).bind(goal.parentGoalId, userId).first();
    if (!parent || parent.level !== expectedParentLevel || parent.status !== "Active") {
      throw new TypeError("The selected parent objective is no longer available.");
    }
  }

  const goalId = `GOAL-${crypto.randomUUID()}`;
  const statements = [
    db.prepare(
      `INSERT INTO goals (
         id, user_id, parent_goal_id, level, title, description, category,
         why_matters, target_outcome, start_date, deadline, status, next_action,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'Active', ?12, ?13, ?13)`
    ).bind(
      goalId,
      userId,
      goal.parentGoalId || null,
      goal.level,
      goal.title,
      goal.description || "",
      goal.category || "",
      goal.whyMatters,
      goal.targetOutcome,
      goal.startDate,
      goal.deadline || null,
      goal.nextAction,
      occurredAt
    )
  ];

  for (const keyResult of goal.keyResults) {
    const keyResultId = `GKR-${crypto.randomUUID()}`;
    statements.push(db.prepare(
      `INSERT INTO goal_key_results (
         id, goal_id, title, baseline_value, current_value, target_value, unit,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?7)`
    ).bind(
      keyResultId,
      goalId,
      keyResult.title,
      keyResult.baselineValue,
      keyResult.targetValue,
      keyResult.unit,
      occurredAt
    ));
  }

  if (goal.projectName) {
    statements.push(db.prepare(
      `INSERT INTO goal_projects (goal_id, project_name, created_at)
       VALUES (?1, ?2, ?3)`
    ).bind(goalId, goal.projectName, occurredAt));
  }
  await db.batch(statements);
  return goalId;
}

export async function updateGoalKeyResult(db, userId, goalId, keyResultId, value, occurredAt) {
  if (!Number.isFinite(value)) throw new TypeError("Key result value must be a finite number.");
  const result = await db.prepare(
    `UPDATE goal_key_results
        SET current_value = ?1, updated_at = ?2
      WHERE id = ?3 AND goal_id = ?4
        AND EXISTS (
          SELECT 1 FROM goals
           WHERE id = ?4 AND user_id = ?5 AND status = 'Active'
        )`
  ).bind(value, occurredAt, keyResultId, goalId, userId).run();
  return result;
}

function validateGoal(goal) {
  if (!goal || typeof goal !== "object") throw new TypeError("Goal details are required.");
  if (!["life_vision", "annual", "quarterly", "monthly", "weekly"].includes(goal.level)) {
    throw new TypeError("Goal level is invalid.");
  }
  for (const field of ["title", "whyMatters", "targetOutcome", "startDate", "nextAction"]) {
    if (typeof goal[field] !== "string" || !goal[field].trim()) {
      throw new TypeError(`Goal ${field} is required.`);
    }
  }
  if (!Array.isArray(goal.keyResults) || goal.keyResults.length < 1) {
    throw new TypeError("At least one measurable key result is required.");
  }
  if (goal.deadline && goal.deadline < goal.startDate) {
    throw new TypeError("Goal deadline cannot be before its start date.");
  }
  for (const keyResult of goal.keyResults) {
    if (
      typeof keyResult.title !== "string" ||
      !keyResult.title.trim() ||
      !Number.isFinite(keyResult.baselineValue) ||
      !Number.isFinite(keyResult.targetValue) ||
      keyResult.baselineValue === keyResult.targetValue ||
      typeof keyResult.unit !== "string" ||
      !keyResult.unit.trim()
    ) {
      throw new TypeError("Each key result requires a measure, different baseline and target, and unit.");
    }
  }
}
