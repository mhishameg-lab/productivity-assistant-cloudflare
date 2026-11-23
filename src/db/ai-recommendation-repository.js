export async function getDailyFocusRecommendation(db, userId, date) {
  validateUserAndDate(userId, date);
  const record = await db.prepare(
    `SELECT id, task_ids_json, decision, generated_at, decided_at
       FROM ai_recommendations
      WHERE user_id = ?1
        AND recommendation_date = ?2
        AND recommendation_type = 'daily_focus'`
  ).bind(userId, date).first();
  if (!record) return null;

  const taskIds = parseTaskIds(record.task_ids_json);
  const tasks = await findTasks(db, taskIds);
  return {
    id: record.id,
    taskIds,
    tasks,
    decision: record.decision,
    generatedAt: record.generated_at,
    decidedAt: record.decided_at
  };
}

export async function saveDailyFocusRecommendation(db, userId, date, taskIds, generatedAt) {
  validateUserAndDate(userId, date);
  validateTaskIds(taskIds);
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new TypeError("Recommendation generation time is invalid.");
  }
  const id = `AI-REC-${crypto.randomUUID()}`;
  await db.prepare(
    `INSERT INTO ai_recommendations (
       id, user_id, recommendation_date, recommendation_type,
       task_ids_json, generated_at
     ) VALUES (?1, ?2, ?3, 'daily_focus', ?4, ?5)
     ON CONFLICT(user_id, recommendation_date, recommendation_type) DO NOTHING`
  ).bind(id, userId, date, JSON.stringify(taskIds), generatedAt).run();
  return getDailyFocusRecommendation(db, userId, date);
}

export async function recordAiRecommendationDecision(db, userId, recommendationId, decision, decidedAt) {
  if (!userId || !/^AI-REC-[A-Za-z0-9-]{1,48}$/.test(String(recommendationId))) {
    throw new TypeError("AI recommendation identity is invalid.");
  }
  if (!["Accepted", "Rejected"].includes(decision)) {
    throw new TypeError("AI recommendation decision is invalid.");
  }
  if (!decidedAt || Number.isNaN(Date.parse(decidedAt))) {
    throw new TypeError("AI recommendation decision time is invalid.");
  }
  return db.prepare(
    `UPDATE ai_recommendations
        SET decision = ?1, decided_at = ?2
      WHERE id = ?3 AND user_id = ?4
      RETURNING id, decision, decided_at`
  ).bind(decision, decidedAt, recommendationId, userId).first();
}

async function findTasks(db, taskIds) {
  if (!taskIds.length) return [];
  const placeholders = taskIds.map((_, index) => `?${index + 1}`).join(", ");
  const result = await db.prepare(
    `SELECT id, title, status, due_date
       FROM tasks
      WHERE id IN (${placeholders})`
  ).bind(...taskIds).all();
  const tasksById = new Map(result.results.map(task => [task.id, task]));
  return taskIds.map(id => tasksById.get(id)).filter(Boolean);
}

function validateUserAndDate(userId, date) {
  if (!userId) throw new TypeError("Recommendation user is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new TypeError("Recommendation date must be a YYYY-MM-DD date key.");
  }
}

function validateTaskIds(taskIds) {
  if (
    !Array.isArray(taskIds) ||
    taskIds.length > 3 ||
    taskIds.some(id => typeof id !== "string" || !id || id.length > 80) ||
    new Set(taskIds).size !== taskIds.length
  ) {
    throw new TypeError("AI recommendation task IDs are invalid.");
  }
}

function parseTaskIds(value) {
  let taskIds;
  try {
    taskIds = JSON.parse(value);
  } catch {
    throw new Error("Stored AI recommendation is invalid.");
  }
  validateTaskIds(taskIds);
  return taskIds;
}
