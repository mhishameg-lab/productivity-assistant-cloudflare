import { logSystemEvent, logSyncEvent } from "./db/channel-repository.js";
import { syncGoogleTaskMirrors } from "./db/google-tasks-repository.js";
import { formatReviewRecommendations } from "./ai/review-analyzer.js";
import { escapeEmailHtml, encodeRfc2047 } from "./core/email.js";
import { cairoTimeParts as formatCairoTimeParts, shortDate } from "./core/format.js";

const CAIRO_TIME_ZONE = "Africa/Cairo";

export async function processScheduledReports({
  db,
  googleTasks,
  gmail,
  recipient,
  aiReviewRecommendations = null,
  htmlEmailsEnabled = false,
  displayName = "Mohamed",
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
    const result = await deliverReport({
      db,
      gmail,
      recipient,
      report,
      aiReviewRecommendations,
      htmlEmailsEnabled,
      displayName,
      now
    });
    totals.generated += result.generated;
    totals.sent += result.sent;
    totals.skipped += result.skipped;
  }
  return totals;
}

async function deliverReport({
  db,
  gmail,
  recipient,
  report,
  aiReviewRecommendations,
  htmlEmailsEnabled,
  displayName,
  now
}) {
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
    let rankedRecommendations = [];
    if (aiReviewRecommendations) {
      try {
        const codes = await aiReviewRecommendations({ report, metrics });
        if (codes !== null && !Array.isArray(codes)) {
          throw new TypeError("AI review recommendations returned an invalid result.");
        }
        rankedRecommendations = formatReviewRecommendations(metrics, codes, report.type);
      } catch (error) {
        await logSystemEvent(db, {
          occurredAt: now.toISOString(),
          severity: "WARN",
          component: "AI review",
          eventType: "AI review unavailable",
          description: `Used deterministic ${report.type} review recommendations.`,
          relatedRecordId: report.periodKey,
          errorMessage: error && error.name ? String(error.name).slice(0, 100) : "Error"
        });
      }
    }
    await saveReportSnapshot(db, report, metrics, rankedRecommendations);
    const text = formatReport(report, metrics, rankedRecommendations);
    const email = htmlEmailsEnabled
      ? {
          to: recipient,
          subject: report.subject,
          text,
          html: formatHtmlReport(report, metrics, rankedRecommendations, displayName)
        }
      : {
          to: recipient,
          subject: report.subject,
          body: text
        };
    const delivery = htmlEmailsEnabled
      ? await gmail.sendMultipart(email)
      : await gmail.sendText(email);
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
        `SELECT t.id, t.title, t.status, t.priority, t.created_at, t.due_date,
                t.completed_at, t.postponement_count,
                (
                  SELECT g.title
                    FROM goal_task_links link
                    JOIN goals g ON g.id = link.goal_id
                   WHERE link.task_id = t.id AND g.status = 'Active'
                   ORDER BY g.deadline IS NULL, g.deadline, g.title
                   LIMIT 1
                ) AS linked_goal_title
           FROM tasks t`
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
  const goalProgress = await calculateGoalProgress(db, start, end);
  const nextWeekStart = shiftDateKey(end, 1);
  const nextWeekEnd = shiftDateKey(nextWeekStart, 6);
  const nextWeekPriorities = rankNextWeekPriorities(
    tasks,
    nextWeekStart,
    nextWeekEnd
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
    goalProgress,
    nextWeekStart,
    nextWeekEnd,
    nextWeekPriorities,
    completionRate: percentage(completed, completed + incomplete) / 100
  };
}

function rankNextWeekPriorities(tasks, start, end) {
  return tasks
    .filter(task =>
      task.status === "Pending" &&
      (
        (task.due_date && task.due_date <= end) ||
        task.priority === "High" ||
        task.linked_goal_title ||
        Number(task.postponement_count || 0) >= 3
      )
    )
    .sort((left, right) => {
      const urgency = task => {
        if (task.due_date && task.due_date < start) return 0;
        if (task.due_date && task.due_date <= end) return 1;
        if (task.priority === "High") return 2;
        return 3;
      };
      return urgency(left) - urgency(right) ||
        priorityRank(left.priority) - priorityRank(right.priority) ||
        compareOptionalDate(left.due_date, right.due_date) ||
        Number(right.postponement_count || 0) - Number(left.postponement_count || 0) ||
        String(left.title || "").localeCompare(String(right.title || ""));
    })
    .slice(0, 5)
    .map(task => ({
      title: String(task.title || ""),
      dueDate: task.due_date || null,
      priority: task.priority || "Medium",
      goalTitle: task.linked_goal_title || null,
      postponementCount: Number(task.postponement_count || 0)
    }));
}

async function calculateGoalProgress(db, start, end) {
  const goalResult = await db.prepare(
    `SELECT g.id, g.level, g.title, g.deadline, g.next_action,
            kr.id AS key_result_id, kr.title AS key_result_title,
            kr.baseline_value, kr.current_value, kr.target_value, kr.unit
       FROM goals g
       LEFT JOIN goal_key_results kr ON kr.goal_id = g.id
      WHERE g.status IN ('Active', 'Paused')
      ORDER BY g.deadline IS NULL, g.deadline, g.title, kr.created_at`
  ).all();
  if (!goalResult.results.length) return [];

  const historyStart = `${shiftDateKey(start, -1)}T00:00:00.000Z`;
  const historyEnd = `${shiftDateKey(end, 2)}T00:00:00.000Z`;
  const historyResult = await db.prepare(
    `SELECT h.key_result_id, h.previous_value, h.recorded_at
       FROM goal_key_result_history h
       JOIN goal_key_results kr ON kr.id = h.key_result_id
       JOIN goals g ON g.id = kr.goal_id
      WHERE g.status IN ('Active', 'Paused')
        AND h.recorded_at >= ?1 AND h.recorded_at < ?2
        AND h.previous_value IS NOT NULL`
  ).bind(historyStart, historyEnd).all();
  const periodUpdates = new Map();
  for (const history of historyResult.results) {
    const recordedDate = cairoDateKey(new Date(history.recorded_at));
    if (recordedDate < start || recordedDate > end) continue;
    periodUpdates.set(
      history.key_result_id,
      (periodUpdates.get(history.key_result_id) || 0) + 1
    );
  }

  const goals = new Map();
  for (const row of goalResult.results) {
    let goal = goals.get(row.id);
    if (!goal) {
      goal = {
        id: row.id,
        level: row.level,
        title: row.title,
        deadline: row.deadline,
        nextAction: row.next_action,
        progress: [],
        measurementUpdates: 0
      };
      goals.set(row.id, goal);
    }
    if (row.key_result_id) {
      const span = row.target_value - row.baseline_value;
      const fraction = span > 0
        ? (row.current_value - row.baseline_value) / span
        : (row.baseline_value - row.current_value) / -span;
      goal.progress.push(Math.min(1, Math.max(0, fraction)));
      goal.measurementUpdates += periodUpdates.get(row.key_result_id) || 0;
    }
  }
  return Array.from(goals.values()).map(goal => ({
    ...goal,
    progressPercent: goal.progress.length
      ? Math.round(goal.progress.reduce((sum, value) => sum + value, 0) / goal.progress.length * 100)
      : null
  }));
}

function confirmedRoutineRate(checkins, routineId, dayCount) {
  const days = new Set(checkins
    .filter(row => row.routine_id === routineId && row.status === "Completed")
    .map(row => row.activity_date));
  return percentage(days.size, dayCount);
}

async function saveReportSnapshot(db, report, metrics, rankedRecommendations = []) {
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
      [
        "Prioritize the clearest next action; delete, delegate, or schedule one open loop.",
        `Goal progress: ${formatGoalProgress(metrics.goalProgress).join(" | ")}`,
        `Next week: ${formatNextWeekPriorities(metrics).join(" | ")}`,
        ...rankedRecommendations.map(text => `AI-ranked: ${text}`)
      ].join("\n")
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
    [
      ...metrics.projectDecisions,
      `Goal progress: ${formatGoalProgress(metrics.goalProgress).join(" | ")}`,
      ...rankedRecommendations.map(text => `AI-ranked: ${text}`)
    ].join("\n"),
    "Review each project: continue, change approach, pause, or kill; record a reason and review date."
  ).run();
}

function formatHtmlReport(report, metrics, rankedRecommendations = [], displayName = "Mohamed") {
  const wins = formatNextWeekPriorities(metrics).slice(0, 3);
  const needs = [
    metrics.overdue ? `${metrics.overdue} overdue tasks` : "No overdue tasks",
    metrics.ignoredReminders ? `${metrics.ignoredReminders} ignored reminders` : "No ignored reminders",
    ...metrics.repeatedProblems.slice(0, 3)
  ];
  const goals = (metrics.goalProgress || []).slice(0, 5).map(goal => {
    const percent = goal.progressPercent == null ? 0 : goal.progressPercent;
    return `<tr><td>${escapeEmailHtml(goal.title)}</td><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="${percent}%" style="background:#5b8def;height:8px;font-size:0">&nbsp;</td><td>&nbsp;</td></tr></table></td></tr>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>@media(prefers-color-scheme:dark){body{background:#111!important;color:#eee!important}.band{background:#20252d!important}.tile{background:#20252d!important;color:#eee!important}}</style></head><body style="margin:0;background:#f5f7fa;color:#1f2933;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden">Your week, ${escapeEmailHtml(displayName)}</span><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="600" style="max-width:600px;width:100%"><tr><td class="band" style="padding:24px;background:#edf3ff"><h1 style="margin:0;font-size:24px">${escapeEmailHtml(report.type === "weekly" ? `Your week, ${displayName}` : `Your month, ${displayName}`)}</h1><p>${escapeEmailHtml(shortDate(report.start))} – ${escapeEmailHtml(shortDate(report.end))}</p></td></tr><tr><td style="padding:16px"><p>You completed ${metrics.completed} tasks and kept ${metrics.planning} of 5 days on plan.</p><table role="presentation" width="100%" cellpadding="8"><tr><td class="tile" align="center">Completed<br><b>${metrics.completed}</b></td><td class="tile" align="center">Open<br><b>${metrics.incomplete}</b></td><td class="tile" align="center">Overdue<br><b>${metrics.overdue}</b></td><td class="tile" align="center">Postponed<br><b>${metrics.postponements}</b></td></tr></table><h2>Wins</h2><ul>${wins.map(value => `<li>${escapeEmailHtml(value)}</li>`).join("")}</ul><h2>Needs attention</h2><ul>${needs.map(value => `<li>${escapeEmailHtml(value)}</li>`).join("")}</ul><h2>Goal progress</h2><table role="presentation" width="100%" cellpadding="6">${goals || "<tr><td>No objective measurements this period.</td></tr>"}</table><h2>Next week</h2><ul>${formatNextWeekPriorities(metrics).slice(0, 5).map(value => `<li>${escapeEmailHtml(value)} · suggestions, not Calendar bookings</li>`).join("")}</ul><p style="font-size:13px;color:#6b7280">Keep this as a small guide, not a debt.</p></td></tr></table></td></tr></table></body></html>`;
}

function formatReport(report, metrics, rankedRecommendations = []) {
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
    `Missed responsibilities: ${metrics.missedResponsibilities.length ? metrics.missedResponsibilities.join(", ") : "None recorded"}`,
    "",
    "Current goal progress and next actions (measurements logged during the period):",
    ...formatGoalProgress(metrics.goalProgress)
  ];
  if (report.type === "weekly") {
    lines.push(
      "",
      `Top priorities for next week (${metrics.nextWeekStart} to ${metrics.nextWeekEnd}; suggestions, not scheduled):`,
      ...formatNextWeekPriorities(metrics)
    );
  }
  if (report.type === "monthly") {
    lines.push(
      `Task completion rate: ${Math.round(metrics.completionRate * 100)}%`,
      `Project decisions recorded: ${metrics.projectDecisions.length || "None"}`
    );
  }
  if (rankedRecommendations.length) {
    lines.push("", "AI-ranked evidence-based suggestions:", ...rankedRecommendations);
  }
  lines.push(
    "",
    report.type === "weekly"
      ? "Next: answer the five guided reflection questions in Telegram with /weekly."
      : "Next: review each project with Continue, Change approach, Pause, or Kill; keep a reason and review date."
  );
  return lines.join("\n");
}

function formatNextWeekPriorities(metrics) {
  const priorities = Array.isArray(metrics.nextWeekPriorities)
    ? metrics.nextWeekPriorities
    : [];
  if (!priorities.length) {
    return ["No pending task currently meets the deadline, priority, goal, or postponement signals."];
  }
  return priorities.map((task, index) => {
    const details = [
      task.dueDate ? `due ${task.dueDate}` : "",
      task.priority === "High" ? "high priority" : "",
      task.goalTitle ? `supports ${task.goalTitle}` : "",
      task.postponementCount >= 3 ? `postponed ${task.postponementCount} times` : ""
    ].filter(Boolean);
    return `${index + 1}. ${task.title}${details.length ? ` — ${details.join("; ")}` : ""}`;
  });
}

function priorityRank(priority) {
  return ({ High: 0, Medium: 1, Low: 2 })[priority] ?? 3;
}

function compareOptionalDate(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return String(left).localeCompare(String(right));
}

function formatGoalProgress(goals) {
  if (!goals.length) return ["No objectives have been defined yet."];
  return goals.slice(0, 5).map(goal => {
    const progress = goal.progressPercent == null
      ? "not measured"
      : `${goal.progressPercent}%`;
    const level = ({
      life_vision: "Life vision",
      annual: "Annual objective",
      quarterly: "Quarterly objective",
      monthly: "Monthly milestone",
      weekly: "Weekly outcome"
    })[goal.level] || goal.level;
    const updates = goal.measurementUpdates === 1
      ? "1 measurement update"
      : `${goal.measurementUpdates} measurement updates`;
    return `${level}: ${goal.title} — ${progress}; ${updates}; next: ${goal.nextAction}`;
  }).concat(goals.length > 5 ? [`${goals.length - 5} more objectives omitted.`] : []);
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
  return formatCairoTimeParts(date);
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
