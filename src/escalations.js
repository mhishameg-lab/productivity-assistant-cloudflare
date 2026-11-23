import { logSystemEvent, logSyncEvent } from "./db/channel-repository.js";
import { syncGoogleTaskMirrors } from "./db/google-tasks-repository.js";
import { cairoDateStart } from "./integrations/google-calendar.js";
import { escapeEmailHtml } from "./core/email.js";
import { cairoTimeParts, shortDate } from "./core/format.js";

const MAX_ESCALATIONS_PER_RUN = 5;
const DEFAULT_ESCALATION_HOURS = 24;

export async function processHighPriorityEscalations({
  db,
  googleTasks,
  gmail,
  recipient,
  htmlEmailsEnabled = false,
  now,
  enabled = false
}) {
  if (!enabled) return { sent: 0, skipped: 0, failed: 0 };

  const local = cairoParts(now);
  const hour = Number(local.hour);
  if (local.minute !== "00" || hour % 2 !== 0) {
    return { sent: 0, skipped: 0, failed: 0 };
  }
  const missingConfiguration = [
    !googleTasks ? "Google Tasks" : null,
    !gmail ? "Gmail" : null,
    !recipient ? "PRODUCTIVITY_EMAIL_RECIPIENT" : null
  ].filter(Boolean);
  if (missingConfiguration.length) {
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "ERROR",
      component: "Email escalation",
      eventType: "Escalation not configured",
      description: "Skipped email escalations because required integration configuration is missing.",
      errorMessage: `Missing: ${missingConfiguration.join(", ")}`
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }

  const date = `${local.year}-${local.month}-${local.day}`;
  const jobKey = `email-escalations:${date}:${local.hour}`;
  const jobId = `JOB-${crypto.randomUUID()}`;
  const claim = await db.prepare(
    `INSERT INTO scheduled_job_runs (id, job_key, started_at, status)
     VALUES (?1, ?2, ?3, 'Processing')
     ON CONFLICT(job_key) DO NOTHING
     RETURNING id`
  ).bind(jobId, jobKey, now.toISOString()).first();
  if (!claim) return { sent: 0, skipped: 1, failed: 0 };

  try {
    const syncedTasks = await googleTasks.listAll();
    await syncGoogleTaskMirrors(db, syncedTasks, now.toISOString());
    await logSyncEvent(db, {
      source: "Google Tasks",
      operation: "Synchronize tasks for email escalation",
      occurredAt: now.toISOString(),
      result: "Success",
      relatedRecordId: `${syncedTasks.length} task(s)`
    });

    const settings = await db.prepare(
      "SELECT setting_value FROM settings WHERE setting_key = 'EMAIL_ESCALATION_HOURS'"
    ).first();
    const thresholdHours = settings
      ? Number(settings.setting_value)
      : DEFAULT_ESCALATION_HOURS;
    if (!Number.isFinite(thresholdHours) || thresholdHours < 1 || thresholdHours > 8760) {
      throw new Error("EMAIL_ESCALATION_HOURS must be a number from 1 to 8760.");
    }

    const candidates = await db.prepare(
      `SELECT id, google_task_id, title, status, priority, due_date,
              postponement_count, escalation_status
         FROM tasks
        WHERE status = 'Pending' AND priority = 'High'
          AND due_date IS NOT NULL AND due_date < ?1
        ORDER BY due_date, id
        LIMIT 100`
    ).bind(date).all();
    const results = { sent: 0, skipped: 0, failed: 0 };

    for (const task of candidates.results) {
      if (results.sent >= MAX_ESCALATIONS_PER_RUN) break;
      const overdueMs = now.getTime() - cairoDateStart(task.due_date).getTime();
      if (overdueMs < thresholdHours * 60 * 60 * 1000) {
        results.skipped++;
        continue;
      }

      const reminders = await db.prepare(
        "SELECT COUNT(*) AS count FROM reminder_history WHERE related_record_id = ?1"
      ).bind(task.id).first();
      if (!reminders || Number(reminders.count) < 1) {
        results.skipped++;
        continue;
      }

      const reason = `Overdue since ${task.due_date}`;
      const prior = await db.prepare(
        `SELECT delivery_result
           FROM email_escalations
          WHERE task_id = ?1 AND reason = ?2`
      ).bind(task.id, reason).all();
      if (prior.results.some(row =>
        ["Sent", "Uncertain", "Sending"].includes(row.delivery_result)
      )) {
        results.skipped++;
        continue;
      }

      const originalDue = await db.prepare(
        `SELECT new_due_date
           FROM task_history
          WHERE task_id = ?1 AND action_type = 'Created'
            AND new_due_date IS NOT NULL
          ORDER BY occurred_at
          LIMIT 1`
      ).bind(task.id).first();
      const previousEscalations = await db.prepare(
        "SELECT COUNT(*) AS count FROM email_escalations WHERE task_id = ?1"
      ).bind(task.id).first();
      const hoursOverdue = Math.floor(overdueMs / (60 * 60 * 1000));
      const subject = `Needs your attention: ${task.title}`;
      const body = [
        `Task: ${task.title}`,
        `Original due date: ${originalDue ? originalDue.new_due_date : task.due_date}`,
        `Current due date: ${task.due_date}`,
        `Current status: ${task.status}`,
        `Postponement count: ${Number(task.postponement_count || 0)}`,
        `Reminder count: ${Number(reminders.count)}`,
        `Time overdue: ${hoursOverdue} hours`,
        "Recommended action: review the task and choose to complete, postpone, or cancel it explicitly."
      ].join("\n");

      const attemptId = await startEscalationAttempt(db, {
        task,
        recipient,
        subject,
        reason,
        previousEscalations: Number(previousEscalations.count || 0),
        now
      });
      let sendError = null;
      try {
        if (htmlEmailsEnabled) {
          const html = `<table role="presentation" width="600" style="max-width:600px;width:100%;margin:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><tr><td style="padding:24px"><h1>Needs your attention</h1><p>This task is overdue: <strong>${escapeEmailHtml(task.title)}</strong>.</p><p>It was due ${escapeEmailHtml(shortDate(task.due_date))} and is ${hoursOverdue} hours overdue.</p><p>Priority: ${escapeEmailHtml(task.priority)}.</p><p>Review it and choose a clear next step: complete it, reschedule it, or leave it open. No task status is being changed.</p></td></tr></table>`;
          await gmail.sendMultipart({ to: recipient, subject, text: body, html });
        } else {
          await gmail.sendText({ to: recipient, subject, body });
        }
      } catch (error) {
        sendError = error;
      }

      const deliveryResult = sendError
        ? sendError.outcomeUncertain ? "Uncertain" : "Failed"
        : "Sent";
      await db.prepare(
        `UPDATE email_escalations
            SET delivery_result = ?1
          WHERE id = ?2 AND delivery_result = 'Sending'`
      ).bind(deliveryResult, attemptId).run();
      await db.prepare(
        "UPDATE tasks SET escalation_status = ?1, updated_at = ?2 WHERE id = ?3"
      ).bind(
        deliveryResult === "Sent"
          ? "Escalated"
          : deliveryResult === "Uncertain" ? "Needs review" : "Failed",
        now.toISOString(),
        task.id
      ).run();

      if (sendError) {
        await logSystemEvent(db, {
          occurredAt: now.toISOString(),
          severity: "ERROR",
          component: "Email escalation",
          eventType: "Delivery failed",
          description: "Could not confirm delivery of a high-priority task escalation.",
          relatedRecordId: task.id,
          errorMessage: sendError.message ? String(sendError.message).slice(0, 500) : "Unknown error"
        });
        results.failed++;
      } else {
        results.sent++;
      }
    }

    await db.prepare(
      `UPDATE scheduled_job_runs
          SET completed_at = ?1, status = ?2
        WHERE id = ?3 AND status = 'Processing'`
    ).bind(
      now.toISOString(),
      results.failed ? "Partially failed" : "Completed",
      jobId
    ).run();
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: results.failed ? "WARN" : "INFO",
      component: "Email escalation",
      eventType: "Escalation cycle completed",
      description: `Sent ${results.sent} high-priority escalation email(s); ${results.failed} failure(s).`,
      relatedRecordId: jobId
    });
    return results;
  } catch (error) {
    await db.prepare(
      `UPDATE scheduled_job_runs
          SET completed_at = ?1, status = 'Failed', error_details = ?2
        WHERE id = ?3 AND status = 'Processing'`
    ).bind(
      now.toISOString(),
      error && error.message ? String(error.message).slice(0, 500) : "Unknown error",
      jobId
    ).run();
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "ERROR",
      component: "Email escalation",
      eventType: "Escalation cycle failed",
      description: "Could not complete the high-priority task escalation cycle.",
      relatedRecordId: jobId,
      errorMessage: error && error.message ? String(error.message).slice(0, 500) : "Unknown error"
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }
}

async function startEscalationAttempt(db, {
  task,
  recipient,
  subject,
  reason,
  previousEscalations,
  now
}) {
  const id = `EMAIL-${crypto.randomUUID()}`;
  await db.prepare(
    `INSERT INTO email_escalations (
       id, task_id, recipient, subject, reason, escalation_level,
       sent_at, delivery_result, previous_escalations
     ) VALUES (?1, ?2, ?3, ?4, ?5, 'Task overdue', ?6, ?7, ?8)`
  ).bind(
    id,
    task.id,
    recipient,
    subject,
    reason,
    now.toISOString(),
    "Sending",
    previousEscalations
  ).run();
  return id;
}

function cairoParts(date) {
  return cairoTimeParts(date);
}
