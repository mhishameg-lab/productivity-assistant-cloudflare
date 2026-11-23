const MANUAL_ROUTINES = [
  {
    id: "ROUTINE-TRELLO",
    name: "Trello updates",
    description: "Manual check-in only; the assistant does not access Trello."
  },
  {
    id: "ROUTINE-OBSIDIAN",
    name: "Obsidian review",
    description: "Manual check-in only; the assistant does not access Obsidian."
  }
];

export async function listManualAccountabilityCheckins(db, activityDate) {
  validateDateKey(activityDate);
  await ensureManualRoutines(db);
  const result = await db.prepare(
    `SELECT r.id AS routine_id, r.name, c.status, c.confirmed_at
       FROM accountability_routines r
       LEFT JOIN accountability_checkins c
         ON c.routine_id = r.id AND c.activity_date = ?1
      WHERE r.id IN ('ROUTINE-TRELLO', 'ROUTINE-OBSIDIAN')
      ORDER BY CASE r.id
        WHEN 'ROUTINE-TRELLO' THEN 0
        ELSE 1
      END`
  ).bind(activityDate).all();
  return result.results;
}

export async function recordManualAccountabilityCheckin(db, routineId, status, activityDate, confirmedAt) {
  validateDateKey(activityDate);
  if (!MANUAL_ROUTINES.some(routine => routine.id === routineId)) {
    throw new TypeError("Manual accountability routine is invalid.");
  }
  if (!["Completed", "Missed"].includes(status)) {
    throw new TypeError("Manual accountability status is invalid.");
  }
  if (!confirmedAt || Number.isNaN(Date.parse(confirmedAt))) {
    throw new TypeError("Manual accountability confirmation time is invalid.");
  }
  await ensureManualRoutines(db);
  const id = `CHECKIN-${routineId}-${activityDate}`;
  await db.prepare(
    `INSERT INTO accountability_checkins (
       id, routine_id, activity_date, status, confirmation_method,
       confirmed_at, reminder_count, postponement_count, notes, tasks_scheduled
     ) VALUES (?1, ?2, ?3, ?4, 'Telegram', ?5, 0, 0, '', 0)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       confirmation_method = excluded.confirmation_method,
       confirmed_at = excluded.confirmed_at`
  ).bind(id, routineId, activityDate, status, confirmedAt).run();
  return { id, routineId, status, activityDate, confirmedAt };
}

async function ensureManualRoutines(db) {
  await db.batch(MANUAL_ROUTINES.map(routine => db.prepare(
    `INSERT INTO accountability_routines (
       id, name, frequency, scheduled_time, active_status,
       maximum_reminders, description
     ) VALUES (?1, ?2, 'Manual', '18:00', 'Active', 0, ?3)
     ON CONFLICT(id) DO NOTHING`
  ).bind(routine.id, routine.name, routine.description)));
}

function validateDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new TypeError("Activity date must be a YYYY-MM-DD date key.");
  }
}
