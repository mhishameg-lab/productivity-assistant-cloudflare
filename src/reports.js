import { logSystemEvent, logSyncEvent } from "./db/channel-repository.js";
import { syncGoogleTaskMirrors } from "./db/google-tasks-repository.js";

const CAIRO_TIME_ZONE = "Africa/Cairo";

export async function processScheduledReports({
  db,
  googleTasks,
  gmail,
  recipient,
  now
}) {
  const date = cairoDateKey(now);
  const local = cairoTimeParts(now);
  if (local.hour !== "18" || local.minute !== "00") {
    return { generated: 0, sent: 0, skipped: 0 };
  }

  const dueReports = [];
  if (local.weekday === "Fri") {
    const range = currentWeekRange(date);
    dueReports.push({
      type: "weekly",
      periodKey: range.start,
      start: range.start,
      end: range.end,
      subject: `Weekly productivity review — ${range.start}`
    });
  }
  if (local.day === "01") {
    const range = previousMonthRange(date);
    dueReports.push({
      type: "monthly",
      periodKey: range.start.slice(0, 7),
      start: range.start,
      end: range.end,
      subject: `Monthly productivity review — ${range.start.slice(0, 7)}`
    });
  }
  if (!dueReports.length) return { generated: 0, sent: 0, skipped: 0 };
  if (!gmail || !recipient) {
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "WARN",
      component: "Reports",
      eventType: "Email delivery not configured",
      description: "Scheduled review snapshots were not generated because Gmail delivery is not configured."
    });
    return { generated: 0, sent: 0, skipped: dueReports.length };
  }
  if (!googleTasks) {
    throw new Error("Google Tasks integration is required to build scheduled reports.");
  }

  const tasks = await googleTasks.listAll();
  await syncGoogleTaskMirrors(db, tasks, now.toISOString());
  await logSyncEvent(db, {
    source: "Google Tasks",
    operation: "Synchronize tasks for scheduled reports",
    occurredAt: now.toISOString(),
    result: "Success",
    relatedRecordId: `${tasks.length} task(s)`
  });

  const totals = { generated: 0, sent: 0, skipped: 0 };
  for (const report of dueReports) {
    const result = await deliverReport({ db, gmail, recipient, report, now });
    totals.generated += result.generated;
    totals.sent += result.sent;
    totals.skipped += result.skipped;
  }
  return totals;
}

async function deliverReport({ db, gmail, recipient, report, now }) {
  const jobKey = `report:${report.type}:${report.periodKey}`;
  const jobId = `JOB-${crypto.randomUUID()}`;
  const claim = await db.prepare(
    `INSERT INTO scheduled_job_runs (id, job_key, started_at, status)
     VALUES (?1, ?2, ?3, 'Processing')
     ON CONFLICT(job_key) DO NOTHING
     RETURNING id`
  ).bind(jobId, jobKey, now.toISOString()).first();
  if (!claim) return { generated: 0, sent: 0, skipped: 1 };

  try {
    const metrics = await calculateReportMetrics(db, report.start, report.end);
    await saveReportSnapshot(db, report, metrics);
    const email = {
      to: recipient,
      subject: report.subject,
      body: formatReport(report, metrics)
    };
    const delivery = await gmail.sendText(email);
    await db.prepare(
      `UPDATE scheduled_job_runs
          SET completed_at = ?1, status = 'Completed'
        WHERE id = ?2 AND status = 'Processing'`
    ).bind(now.toISOString(), jobId).run();
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "INFO",
      component: "Reports",
      eventType: "Scheduled report sent",
      description: `Sent ${report.type} review report for ${report.periodKey}.`,
      relatedRecordId: delivery.id
    });
    return { generated: 1, sent: 1, skipped: 0 };
  } catch (error) {
    const status = error && error.outcomeUncertain ? "Needs review" : "Failed";
    await db.prepare(
      `UPDATE scheduled_job_runs
          SET completed_at = ?1, status = ?2, error_details = ?3
        WHERE id = ?4 AND status = 'Processing'`
    ).bind(
      now.toISOString(),
      status,
      error && error.message ? String(error.message).slice(0, 500) : "Unknown error",
      jobId
    ).run();
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "ERROR",
      component: "Reports",
      eventType: "Scheduled report delivery failed",
      description: `Could not complete the ${report.type} report for ${report.periodKey}.`,
      relatedRecordId: jobId,
      errorMessage: error && error.message ? String(error.message).slice(0, 500) : "Unknown error"
    });
    throw error;
  }
}

async function calculateReportMetrics(db, start, end) {
  const [taskResult, historyResult, dailyResult, checkinResult, reminderResult, noteResult] =
    await Promise.all([
      db.prepare(
        `SELECT id, title, status, priority, created_at, due_date, completed_at,
                postponement_count
           FROM tasks`
      ).all(),
      db.prepare(
        `SELECT task_id, action_type, occurred_at
           FROM task_history
          WHERE substr(occurred_at, 1, 10) BETWEEN ?1 AND ?2`
      ).bind(start, end).all(),
      db.prepare(
        `SELECT review_date, planning_completed, accountability_score
           FROM daily_reviews
          WHERE review_date BETWEEN ?1 AND ?2`
      ).bind(start, end).all(),
      db.prepare(
        `SELECT routine_id, activity_date, status
           FROM accountability_checkins
          WHERE activity_date BETWEEN ?1 AND ?2`
      ).bind(start, end).all(),
      db.prepare(
        `SELECT delivery_status, sent_at
           FROM reminder_history
          WHERE sent_at IS NOT NULL AND substr(sent_at, 1, 10) BETWEEN ?1 AND ?2`
      ).bind(start, end).all(),
      db.prepare(
        `SELECT question, answer
           FROM review_notes
          WHERE review_type = 'Monthly project decision'
            AND review_date BETWEEN ?1 AND ?2
          ORDER BY review_date, created_at`
      ).bind(start, end).all()
    ]);

  const tasks = taskResult.results;
  const inPeriod = value => {
    const key = String(value || "").slice(0, 10);
    return key >= start && key <= end;
  };
  const periodTasks = tasks.filter(task =>
    inPeriod(task.created_at) || inPeriod(task.completed_at) || inPeriod(task.due_date)
  );
  const completed = periodTasks.filter(task =>
    task.status === "Completed" && inPeriod(task.completed_at)
  ).length;
  const incomplete = periodTasks.filter(task => task.status === "Pending").length;
  const overdue = tasks.filter(task =>
    task.status === "Pending" && task.due_date && task.due_date < end
  ).length;
  const postponements = historyResult.results.filter(row =>
    String(row.action_type).toLowerCase().includes("postpon")
  ).length;
  const dayCount = daysBetween(start, end) + 1;
  const dailyReviews = dailyResult.results;
  const planning = percentage(
    new Set(dailyReviews.filter(row => Number(row.planning_completed) === 1).map(row => row.review_date)).size,
    dayCount
  );
  const checkins = checkinResult.results;
  const trello = confirmedRoutineRate(checkins, "ROUTINE-TRELLO", dayCount);
  const obsidian = confirmedRoutineRate(checkins, "ROUTINE-OBSIDIAN", dayCount);
  const scores = dailyReviews
    .filter(row => row.accountability_score != null && row.accountability_score !== "")
    .map(row => Number(row.accountability_score))
    .filter(Number.isFinite);
  const averageScore = scores.length
    ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : null;
  const repeatedProblems = periodTasks
    .filter(task => Number(task.postponement_count || 0) >= 3)
    .slice(0, 5)
    .map(task => task.title);
  const routineNames = {
    "ROUTINE-DAILY-PLAN": "Daily planning",
    "ROUTINE-DAILY-REVIEW": "Daily review",
    "ROUTINE-TRELLO": "Trello updates",
    "ROUTINE-OBSIDIAN": "Obsidian updates",
    "ROUTINE-CALENDAR": "Calendar adherence"
  };
  const missedResponsibilities = Array.from(new Set(
    checkins.filter(row => row.status === "Missed")
      .map(row => routineNames[row.routine_id] || row.routine_id)
  ));
  const ignoredReminders = reminderResult.results.filter(row =>
    row.delivery_status === "Ignored"
  ).length;
  const projectDecisions = noteResult.results.map(row =>
    `${row.question}: ${row.answer}`
  );

  return {
    created: periodTasks.filter(task => inPeriod(task.created_at)).length,
    completed,
    incomplete,
    overdue,
    postponements,
    planning,
    trello,
    obsidian,
    averageScore,
    repeatedProblems,
    missedResponsibilities,
    ignoredReminders,
    projectDecisions,
    completionRate: percentage(completed, completed + incomplete) / 100
  };
}

function confirmedRoutineRate(checkins, routineId, dayCount) {
  const days = new Set(checkins
    .filter(row => row.routine_id === routineId && row.status === "Completed")
    .map(row => row.activity_date));
  return percentage(days.size, dayCount);
}

async function saveReportSnapshot(db, report, metrics) {
  if (report.type === "weekly") {
    await db.prepare(
      `INSERT INTO weekly_reviews (
         week_starting_date, tasks_created, tasks_completed, tasks_overdue,
         postponements, planning_consistency, trello_maintenance_rate,
         obsidian_maintenance_rate, average_accountability_score,
         repeated_problems, recommendations
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(week_starting_date) DO UPDATE SET
         tasks_created = excluded.tasks_created,
         tasks_completed = excluded.tasks_completed,
         tasks_overdue = excluded.tasks_overdue,
         postponements = excluded.postponements,
         planning_consistency = excluded.planning_consistency,
         trello_maintenance_rate = excluded.trello_maintenance_rate,
         obsidian_maintenance_rate = excluded.obsidian_maintenance_rate,
         average_accountability_score = excluded.average_accountability_score,
         repeated_problems = excluded.repeated_problems,
         recommendations = excluded.recommendations`
    ).bind(
      report.start,
      metrics.created,
      metrics.completed,
      metrics.overdue,
      metrics.postponements,
      metrics.planning,
      metrics.trello,
      metrics.obsidian,
      metrics.averageScore,
      metrics.repeatedProblems.join(", "),
      "Prioritize the clearest next action; delete, delegate, or schedule one open loop."
    ).run();
    return;
  }

  await db.prepare(
    `INSERT INTO monthly_reviews (
       month, tasks_created, tasks_completed, task_completion_rate,
       tasks_overdue, postponements, planning_consistency,
       trello_maintenance_rate, obsidian_maintenance_rate,
       average_accountability_score, recurring_problems, improvements,
       recommendations
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(month) DO UPDATE SET
       tasks_created = excluded.tasks_created,
       tasks_completed = excluded.tasks_completed,
       task_completion_rate = excluded.task_completion_rate,
       tasks_overdue = excluded.tasks_overdue,
       postponements = excluded.postponements,
       planning_consistency = excluded.planning_consistency,
       trello_maintenance_rate = excluded.trello_maintenance_rate,
       obsidian_maintenance_rate = excluded.obsidian_maintenance_rate,
       average_accountability_score = excluded.average_accountability_score,
       recurring_problems = excluded.recurring_problems,
       improvements = excluded.improvements,
       recommendations = excluded.recommendations`
  ).bind(
    report.periodKey,
    metrics.created,
    metrics.completed,
    metrics.completionRate,
    metrics.overdue,
    metrics.postponements,
    metrics.planning,
    metrics.trello,
    metrics.obsidian,
    metrics.averageScore,
    metrics.repeatedProblems.join(", "),
    metrics.projectDecisions.join("\n"),
    "Review each project: continue, change approach, pause, or kill; record a reason and review date."
  ).run();
}

function formatReport(report, metrics) {
  const lines = [
    `${report.type === "weekly" ? "Weekly" : "Monthly"} productivity review`,
    `${report.start} to ${report.end}`,
    "",
    `Tasks created / completed: ${metrics.created} / ${metrics.completed}`,
    `Open / overdue: ${metrics.incomplete} / ${metrics.overdue}`,
    `Postponements: ${metrics.postponements}`,
    `Planning consistency: ${metrics.planning}%`,
    `Manual Trello / Obsidian check-ins: ${metrics.trello}% / ${metrics.obsidian}%`,
    `Average confirmed accountability score: ${metrics.averageScore == null ? "Not available" : metrics.averageScore}`,
    `Ignored reminders: ${metrics.ignoredReminders}`,
    `Repeated postponements: ${metrics.repeatedProblems.length ? metrics.repeatedProblems.join("; ") : "None identified"}`,
    `Missed responsibilities: ${metrics.missedResponsibilities.length ? metrics.missedResponsibilities.join(", ") : "None recorded"}`
  ];
  if (report.type === "monthly") {
    lines.push(
      `Task completion rate: ${Math.round(metrics.completionRate * 100)}%`,
      `Project decisions recorded: ${metrics.projectDecisions.length || "None"}`
    );
  }
  lines.push(
    "",
    report.type === "weekly"
      ? "Next: answer the five guided reflection questions in Telegram with /weekly."
      : "Next: review each project with Continue, Change approach, Pause, or Kill; keep a reason and review date."
  );
  return lines.join("\n");
}

function currentWeekRange(date) {
  const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const start = shiftDateKey(date, -daysSinceMonday);
  return { start, end: shiftDateKey(start, 6) };
}

function previousMonthRange(date) {
  const currentMonthStart = `${date.slice(0, 7)}-01`;
  const end = shiftDateKey(currentMonthStart, -1);
  const start = `${end.slice(0, 7)}-01`;
  return { start, end };
}

function cairoDateKey(date) {
  const parts = cairoTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function cairoTimeParts(date) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: CAIRO_TIME_ZONE,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );
  return values;
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  return Math.round(
    (Date.parse(`${end}T12:00:00.000Z`) - Date.parse(`${start}T12:00:00.000Z`)) /
    86_400_000
  );
}

function percentage(numerator, denominator) {
  return denominator ? Math.round(100 * numerator / denominator) : 0;
}
