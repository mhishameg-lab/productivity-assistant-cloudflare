import {
  appendFocusOutcomeStatus,
  listOverdueTaskMirrors,
  listPendingTaskMirrors,
  listPendingTaskPlanningCandidates,
  syncGoogleTaskMirrors,
  upsertGoogleTaskMirror
} from "../db/google-tasks-repository.js";
import {
  createGoal,
  getGoal,
  getGoalKeyResult,
  getGoalKeyResults,
  getGoalProjects,
  getGoalTaskLinks,
  linkGoalTask,
  listDailyGoalFocus,
  listGoalParents,
  listGoals,
  updateGoalKeyResult
} from "../db/goal-repository.js";
import {
  listManualAccountabilityCheckins,
  recordManualAccountabilityCheckin
} from "../db/accountability-repository.js";
import {
  getDailyFocusRecommendation,
  recordAiRecommendationDecision,
  saveDailyFocusRecommendation
} from "../db/ai-recommendation-repository.js";
import {
  clearConversationState,
  getConversationState,
  getTaskCreationRequest,
  logSyncEvent,
  logSystemEvent,
  setConversationState,
  startTaskCreationRequest,
  updateTaskCreationRequest
} from "../db/channel-repository.js";
import {
  claimFocusSessionResponse,
  finalizeFocusSessionResponse,
  getFocusSession,
  recordFocusSession,
  releaseFocusSessionResponse
} from "../scheduled.js";
import { buildDailyTaskPlan, formatDailyTaskPlan } from "./daily-planner.js";
import { cairoLocalDateTimeToIso } from "../integrations/google-calendar.js";
import {
  resolveAvailableTimeRequest,
  resolveDeterministicTextIntent,
  resolveIntent
} from "./intent.js";
import {
  areaLabel,
  cairoDateKey as formattedCairoDateKey,
  cairoTimeParts,
  longDate,
  parseCairoDateTime,
  parseDateInput,
  parseTimeInput,
  shortDate,
  dateTimeLabel,
  greetingLine,
  timeLabel
} from "./format.js";
import { getDisplayName, say } from "./voice.js";
import {
  createUserReminder,
  listPendingUserReminders,
  parseUserReminder
} from "../user-reminders.js";

export async function handleAssistantMessage({
  db,
  user,
  message,
  googleTasks,
  googleCalendar = null,
  googleGmail = null,
  naturalLanguageClassifier = null,
  aiDailyPlanner = null,
  emailFollowUpAnalyzer = null,
  now
}) {
  let intent = resolveIntent(message);
  if (intent.type === "user_action") {
    return handleAction({
      db, user, message, intent, googleTasks, googleCalendar, googleGmail,
      aiDailyPlanner, now
    });
  }

  if (intent.type === "unknown_command") {
    return response("Unknown command", "I don't recognize that shortcut. Use /help to see what you can do.");
  }
  if (intent.type === "unsupported_input") return null;
  if (intent.type === "user_message") {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (state) {
      return handleConversationText({
        db, user, message, state, googleTasks, googleCalendar, aiDailyPlanner, now
      });
    }
    if (/^(?:remind me|in \d|tomorrow at|on .+ at|\d{1,2}\/\d{1,2})/i.test(intent.text.trim())) {
      return handleUserReminderCommand({
        db,
        user,
        intent: { arguments: intent.text.trim() },
        now
      });
    }
    if (/^▶\s*Next$/i.test(intent.text.trim())) {
      return showNextRecommendation({ db, user, now });
    }
    if (/^🗓\s*Plan$/i.test(intent.text.trim())) {
      return showPlanForDate({
        db, user, googleTasks, googleCalendar,
        date: cairoDateKey(now), title: "Plan today", now
      });
    }
    if (/^➕\s*Add$/i.test(intent.text.trim())) {
      return beginTaskCapture(db, user, now);
    }
    if (/^📋\s*Today$/i.test(intent.text.trim())) {
      return showHome({ db, user, googleTasks, googleCalendar, aiDailyPlanner, now });
    }
    const shortcut = parseTypedShortcut(intent.text);
    if (shortcut) {
      return beginShortcutFocus({
        db,
        user,
        area: shortcut.area,
        duration: shortcut.duration,
        googleTasks,
        now
      });
    }
    const quickTask = parseQuickCapture(intent.text, now);
    if (quickTask) {
      return createQuickCapturedTask({
        db,
        user,
        googleTasks,
        capture: quickTask,
        now
      });
    }
    const availability = resolveAvailableTimeRequest(intent.text);
    if (availability) {
      return beginAvailableTimeRequest({
        db, user, minutes: availability.minutes, now
      });
    }
    const deterministicName = resolveDeterministicTextIntent(intent.text);
    if (deterministicName) {
      intent = { type: "command", name: deterministicName, arguments: "" };
    } else if (naturalLanguageClassifier) {
      try {
        const name = await naturalLanguageClassifier(intent.text);
        if (name && name !== "unknown") {
          intent = { type: "command", name, arguments: "" };
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: "ai_intent_classification_failed",
          errorType: error && error.name || "Error"
        }));
      }
    }
    if (intent.type === "user_message") {
      return response(
        "Message",
        "I couldn't safely match that request to an available action. Try a direct command or /help."
      );
    }
  }

  switch (intent.name) {
    case "hq":
      return showCalmHome({ db, user, googleTasks, googleCalendar, aiDailyPlanner, now });
    case "start":
    case "today":
      return showHome({ db, user, googleTasks, googleCalendar, aiDailyPlanner, now });
    case "go":
    case "next":
    case "focus":
      return beginFocusNow({ db, user, now });
    case "drop":
      return beginTaskCapture(db, user, now);
    case "wya":
      return showWhereIAm({ db, user, now });
    case "stack":
      return showTaskStack({ db, googleTasks, now });
    case "tasks":
      return showTasks({ db, googleTasks, now });
    case "late":
      return showOverdueTasks({ db, googleTasks, now });
    case "mail":
    case "inbox":
      return showInboxTriage({ db, googleGmail, emailFollowUpAnalyzer, now });
    case "pipeline":
      return showPipelineOverview();
    case "remind":
    case "reminders":
      return handleUserReminderCommand({ db, user, intent, now });
    case "help":
      return {
        category: "Control panel",
        title: "What do you need?",
        sections: [{
          heading: "",
          lines: [
            "Plan my day",
            "Review overdue tasks",
            "Review unread inbox",
            "Trello / Obsidian check-in",
            "Review goals",
            "Add a task",
            "Focus now",
            "Plan a free-time window",
            "Review progress",
            "Capture an idea",
            "Weekly review",
            "Monthly project decision",
            "Settings",
            "Shortcuts: /today · /available 90 · /tasks · /overdue · /inbox · /accountability · /goals · /goal · /addtask · /weekly · /monthly"
          ]
        }],
        actions: [[
          { label: "Add a task", action: "add_task" },
          { label: "Show tasks", action: "show_tasks" }
        ], [
          { label: "Review goals", action: "goals_show" },
          { label: "Create a goal", action: "goal_new" }
        ], [
          { label: "Weekly review", action: "weekly_start" },
          { label: "Monthly project", action: "monthly_project_review" }
        ]]
      };
    case "tasks":
      return showTasks({ db, googleTasks, now });
    case "overdue":
      return showOverdueTasks({ db, googleTasks, now });
    case "inbox":
      return showInboxTriage({ db, googleGmail, emailFollowUpAnalyzer, now });
    case "accountability":
      return showManualAccountabilityCheckin({ db, now });
    case "goals":
      return showGoals({ db, user });
    case "goal":
      return beginGoalCapture(db, user, now);
    case "tomorrow":
      return showPlanForDate({
        db,
        user,
        googleTasks,
        googleCalendar,
        date: shiftDateKey(cairoDateKey(now), 1),
        title: "Tomorrow's plan",
        now
      });
    case "weekly":
      return beginWeeklyReview({ db, user, now });
    case "monthly":
      return beginMonthlyProjectReview({ db, user, now });
    case "addtask":
      return beginTaskCapture(db, user, now);
    case "available": {
      const minutes = intent.arguments.trim()
        ? Number(intent.arguments.trim())
        : null;
      return beginAvailableTimeRequest({ db, user, minutes, now });
    }
    case "focus":
      return beginFocusNow({ db, user, now });
    case "quiet": {
      const duration = parseQuietDuration(intent.arguments);
      if (!duration) return response("Quiet time", "Use /quiet 2h.");
      await setConversationState(db, user.id, {
        type: "quiet",
        mutedUntil: new Date(now.getTime() + duration * 60_000).toISOString()
      }, now.toISOString());
      await db.prepare(
        `INSERT OR REPLACE INTO settings (setting_key, setting_value, description, category, updated_at)
         VALUES ('pulse_muted_until', ?1, 'Proactive pulse mute expiry', 'Pulses', ?2)`
      ).bind(new Date(now.getTime() + duration * 60_000).toISOString(), now.toISOString()).run();
      return response("Quiet mode", `Pulses and care notes are muted for ${duration >= 60 ? `${duration / 60} hour${duration === 60 ? "" : "s"}` : `${duration} minutes`}.`);
    }
    case "pulses":
      return showPulseStatus(db, user.id, now);
    case "vibe":
    case "tone":
      return updateToneSetting(db, intent.arguments, now);
    default:
      return response(
        "Migration status",
        "That workflow is not migrated yet. Use /help to see the available controls."
      );
  }
}

async function handleAction({
  db,
  user,
  message,
  intent,
  googleTasks,
  googleCalendar,
  googleGmail,
  aiDailyPlanner,
  now
}) {
  const identifier = intent.identifier;
  const nightConfirm = identifier.match(/^night_confirm\|(\d{4}-\d{2}-\d{2})$/);
  if (nightConfirm) {
    const date = nightConfirm[1];
    const completed = await db.prepare(
      "SELECT COUNT(*) AS count FROM daily_outcomes WHERE outcome_date=?1 AND status='Completed'"
    ).bind(date).first();
    await db.prepare(
      `INSERT INTO daily_reviews (
         review_date, planning_completed, review_completed, observations
       ) VALUES (?1, 1, 1, ?2)
       ON CONFLICT(review_date) DO UPDATE SET
         planning_completed=1, review_completed=1, observations=excluded.observations`
    ).bind(date, Number(completed.count) ? "User-confirmed day." : "Fresh run tomorrow.").run();
    return response("Night wrap", Number(completed.count) ? "Locked in. Solid day. 💪" : "Locked in. Tomorrow's a fresh run.");
  }
  const reminderTime = identifier.match(/^reminder_time\|(09:00|12:00|17:00|custom)$/);
  if (reminderTime) {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "reminder_time") return response("Reminder", "That reminder has expired.");
    if (reminderTime[1] === "custom") {
      await setConversationState(db, user.id, { ...state, type: "reminder_time_custom" }, now.toISOString());
      return {
        category: "Reminder",
        title: "",
        sections: [{ heading: "", lines: ["Enter a date and time, for example 11/25/2026 3:00 PM."] }],
        inputMode: "force_reply",
        inputPlaceholder: "11/25/2026 3:00 PM"
      };
    }
    const dateKey = cairoDateKey(now);
    const due = new Date(cairoDateTimeToUtcForReminder(dateKey, reminderTime[1]));
    if (due.getTime() <= now.getTime()) due.setUTCDate(due.getUTCDate() + 1);
    await createUserReminder({
      db, user, text: state.text, dueAtUtc: due.toISOString(), now: now.toISOString()
    });
    await clearConversationState(db, user.id);
    return response("Reminder", `Got it. I'll remind you to “${state.text}” at ${timeLabel(due)}. ⏰`);
  }
  const reminderDone = identifier.match(/^reminder_done\|(REM-[A-Za-z0-9-]+)$/);
  if (reminderDone) {
    await db.prepare("UPDATE reminders SET status='done' WHERE id=?1 AND status IN ('sent','sending','snoozed')")
      .bind(reminderDone[1]).run();
    return response("Reminder", "Got it.");
  }
  const reminderCancel = identifier.match(/^reminder_cancel\|(REM-[A-Za-z0-9-]+)$/);
  if (reminderCancel) {
    await db.prepare("UPDATE reminders SET status='cancelled' WHERE id=?1")
      .bind(reminderCancel[1]).run();
    return response("Reminder", "Reminder cancelled.");
  }
  const reminderSnooze = identifier.match(/^reminder_snooze\|(REM-[A-Za-z0-9-]+)\|(15|60)$/);
  if (reminderSnooze) {
    const minutes = Number(reminderSnooze[2]);
    const current = await db.prepare("SELECT remind_at_utc FROM reminders WHERE id=?1")
      .bind(reminderSnooze[1]).first();
    const due = new Date((current ? Date.parse(current.remind_at_utc) : now.getTime()) + minutes * 60_000);
    await db.prepare(
      `UPDATE reminders
          SET remind_at_utc=?1, status='pending', snooze_count=snooze_count+1
        WHERE id=?2`
    ).bind(due.toISOString(), reminderSnooze[1]).run();
    return response("Reminder", `Snoozed till ${timeLabel(due)}.`);
  }
  const reminderTask = identifier.match(/^reminder_task\|(REM-[A-Za-z0-9-]+)$/);
  if (reminderTask) {
    const reminder = await db.prepare("SELECT text FROM reminders WHERE id=?1")
      .bind(reminderTask[1]).first();
    if (!reminder) return response("Reminder", "That reminder is no longer available.");
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    return createCapturedTask({
      db,
      user,
      state: {
        requestId: `TASK-REM-${reminderTask[1]}`,
        title: reminder.text,
        area: "Other",
        priority: "Medium",
        dueDate: "",
        doneTest: "Complete the reminder's requested action."
      },
      addToTop3: false,
      googleTasks,
      now,
      clearConversation: false
    });
  }
  if (identifier === "home_more") {
    return showFullPlan({ db, user, googleTasks, googleCalendar, now });
  }
  if (identifier === "home_back") {
    return showCalmHome({ db, user, googleTasks, googleCalendar, aiDailyPlanner: null, now });
  }
  if (identifier === "wya") {
    return showWhereIAm({ db, user, now });
  }
  if (identifier === "pipeline_rhythm") {
    return {
      category: "Daily rhythm",
      title: "",
      sections: [{ heading: "", lines: [
        "Morning at your wake time or 8:00 AM.",
        "Check-ins every 30 minutes outside the shift.",
        "Every 60 minutes during 3:00 PM–11:00 PM.",
        "Work prompt at 2:15 PM on workdays.",
        "Mid-shift check-in at 7:00 PM.",
        "Night wrap at 11:15 PM.",
        "Reminders at the times you set.",
        "Calendar heads-up 15 minutes before events.",
        "Friday 6:00 PM weekly email.",
        "First of month 6:00 PM monthly email.",
        "Sunday 10:00 AM system status."
      ] }],
      actions: [[{ label: "⬅ Back", action: "pipeline_overview" }]]
    };
  }
  if (identifier === "pipeline_rules") {
    return {
      category: "My rules",
      title: "",
      sections: [{ heading: "", lines: [
        "I never finish or cancel a task for you.",
        "You tap Done.",
        "I only add a calendar block when you tell me to.",
        "I never send email except scheduled reports.",
        "I never change your mail.",
        "If Google doesn't answer, I tell you.",
        "Dive or sleep means I go quiet."
      ] }],
      actions: [[{ label: "⬅ Back", action: "pipeline_overview" }]]
    };
  }
  if (identifier === "pipeline_overview") return showPipelineOverview();
  if (identifier === "home") {
    return showHome({ db, user, googleTasks, googleCalendar, aiDailyPlanner, now });
  }
  if (identifier.startsWith("pulse|")) {
    return handlePulseAction({ db, user, identifier, googleTasks, now });
  }
  const aiPlan = identifier.match(/^ai_daily_plan\|(\d{4}-\d{2}-\d{2})$/);
  if (aiPlan) {
    return showAiDailyPrioritySuggestion({
      db, user, googleTasks, aiDailyPlanner, date: aiPlan[1], now
    });
  }
  const aiDecision = identifier.match(/^ai_recommendation\|(AI-REC-[A-Za-z0-9-]{1,48})\|(accepted|rejected)$/);
  if (aiDecision) {
    const decision = aiDecision[2] === "accepted" ? "Accepted" : "Rejected";
    const saved = await recordAiRecommendationDecision(
      db,
      user.id,
      aiDecision[1],
      decision,
      now.toISOString()
    );
    if (!saved) {
      return response("Recommendation unavailable", "Open today's plan to review the current recommendation.");
    }
    return response(
      "Recommendation response recorded",
      `Recorded as ${decision.toLowerCase()}. No task status, due date, or calendar event was changed.`
    );
  }
  if (identifier === "show_tasks") return showTasks({ db, googleTasks, now });
  const gmailDismiss = identifier.match(/^gmail_followup_dismiss\|([A-Za-z0-9_-]{1,32})$/);
  if (gmailDismiss) {
    return response(
      "Email follow-up dismissed",
      "No task was created and the email was not changed."
    );
  }
  const gmailFollowUp = identifier.match(/^gmail_followup_task\|([A-Za-z0-9_-]{1,32})$/);
  if (gmailFollowUp) {
    if (!googleTasks || !googleGmail) {
      return response(
        "Email task unavailable",
        "Gmail and Google Tasks must both be connected. No task was created."
      );
    }
    const thread = await googleGmail.getThreadSummary(gmailFollowUp[1]);
    if (!thread) {
      return response(
        "Email conversation unavailable",
        "I couldn't verify that Gmail conversation. No task was created."
      );
    }
    return createCapturedTask({
      db,
      user,
      state: {
        requestId: `TASK-GMAIL-${thread.threadId}`,
        title: `Follow up: ${truncate(thread.subject || "(no subject)", 160)}`,
        area: "Admin",
        priority: "Medium",
        dueDate: "",
        doneTest: "Review the email thread and complete or define the requested next step."
      },
      addToTop3: false,
      googleTasks,
      now,
      clearConversation: false
    });
  }
  if (identifier === "goals_show") return showGoals({ db, user });
  if (identifier === "goal_new") return beginGoalCapture(db, user, now);
  if (identifier === "add_task") return beginTaskCapture(db, user, now);
  if (identifier === "focus_now") return beginFocusNow({ db, user, now });
  if (identifier === "plan_next_day_now") return beginNextDayPlanning({ db, user, now });
  if (identifier === "plan_my_day") {
    return {
      ...(await showPlanForDate({
        db,
        user,
        googleTasks,
        googleCalendar,
        date: cairoDateKey(now),
        title: "Plan today",
        now
      })),
      actions: [
        [{ label: "Today is planned", action: `plan_confirm_date|${cairoDateKey(now)}` }],
        [{ label: "Plan tomorrow", action: "plan_next_day_now" }],
        [{ label: "Back to home", action: "home" }]
      ]
    };
  }
  const reminderLater = identifier.match(/^task_reminder_later\|([^|]+)$/);
  if (reminderLater) {
    const updated = await db.prepare(
      `UPDATE reminder_history
          SET user_response = 'Postponed', confirmed_at = ?1
        WHERE related_record_id = (
            SELECT related_record_id FROM reminder_history
             WHERE id = ?2 AND category = 'Overdue task'
               AND delivery_status = 'Sent'
          )
          AND category = 'Overdue task' AND delivery_status = 'Sent'
          AND user_response IS NULL
        RETURNING id`
    ).bind(now.toISOString(), reminderLater[1]).first();
    return updated
      ? response("Reminder deferred", "The task remains open. This reminder is deferred until the next eligible daily check.")
      : response("Reminder already handled", "That reminder has already been answered.");
  }
  const calendarReminderResponse = identifier.match(
    /^cal_(prepared|dismissed)\|(CALREM-[0-9a-f-]{36})$/
  );
  if (calendarReminderResponse) {
    const userResponse = calendarReminderResponse[1] === "prepared"
      ? "Prepared"
      : "Dismissed";
    const updated = await db.prepare(
      `UPDATE reminder_history
          SET user_response = ?1, confirmed_at = ?2
        WHERE id = ?3 AND category = 'Calendar appointment'
          AND delivery_status = 'Sent' AND user_response IS NULL
        RETURNING id`
    ).bind(userResponse, now.toISOString(), calendarReminderResponse[2]).first();
    return updated
      ? response(
          "Appointment reminder updated",
          userResponse === "Prepared"
            ? "Marked prepared. No Calendar event or task was changed."
            : "Reminder dismissed. No Calendar event or task was changed."
        )
      : response("Reminder already handled", "That appointment reminder has already been answered.");
  }
  const accountability = identifier.match(/^accountability_(done|missed)\|(ROUTINE-(?:TRELLO|OBSIDIAN))$/);
  if (accountability) {
    const routineId = accountability[2];
    const status = accountability[1] === "done" ? "Completed" : "Missed";
    await recordManualAccountabilityCheckin(
      db,
      routineId,
      status,
      cairoDateKey(now),
      now.toISOString()
    );
    const label = routineId === "ROUTINE-TRELLO" ? "Trello" : "Obsidian";
    return response(
      "Manual accountability check-in",
      status === "Completed"
        ? `Recorded: ${label} updated today.`
        : `Recorded: ${label} was not updated today. No external service was changed.`
    );
  }
  const planConfirmation = identifier.match(/^(?:plan_confirm_today|plan_confirm_date\|(\d{4}-\d{2}-\d{2}))$/);
  if (planConfirmation) {
    const date = planConfirmation[1] || cairoDateKey(now);
    if (!isValidDateKey(date) || date !== cairoDateKey(now)) {
      return response("Planning checkpoint not open", "Confirm the plan during that date's midnight planning checkpoint.");
    }
    await db.prepare(
      `INSERT INTO daily_reviews (review_date, planning_completed)
       VALUES (?1, 1)
       ON CONFLICT(review_date) DO UPDATE SET planning_completed = 1`
    ).bind(date).run();
    return {
      category: "Planning confirmed",
      title: "Plan confirmed",
      sections: [{ heading: "", lines: ["Your planning checkpoint is recorded. Keep the three outcomes visible and adjust only when necessary."] }],
      actions: [[{ label: "Back to home", action: "home" }]]
    };
  }
  if (identifier === "shutdown_done") {
    await recordReviewNote(db, {
      id: `SHUTDOWN-${cairoDateKey(now)}`,
      reviewType: "Daily shutdown",
      reviewDate: cairoDateKey(now),
      question: "Open loops",
      answer: "User confirmed there are no open loops to capture.",
      createdAt: now.toISOString()
    });
    return {
      category: "Shutdown",
      title: "Shutdown confirmed",
      sections: [{ heading: "", lines: ["Open loops are acknowledged. Start planning tomorrow when ready."] }],
      actions: [[{ label: "Plan tomorrow now", action: "plan_next_day_now" }]]
    };
  }
  if (identifier === "weekly_start") return beginWeeklyReview({ db, user, now });
  if (identifier === "monthly_project_review") return beginMonthlyProjectReview({ db, user, now });
  if (identifier === "goal_cancel") {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "goal_confirm") {
      return response("Goal interview expired", "Start again with /goal when you are ready.");
    }
    await clearConversationState(db, user.id);
    return response("Goal not saved", "The objective was not added.");
  }
  if (identifier === "goal_link_cancel") {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (state && state.type === "goal_task_link") await clearConversationState(db, user.id);
    return response("Task linking cancelled", "No task was linked.");
  }
  if (identifier === "goal_save") {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "goal_confirm") {
      return response("Goal interview expired", "Start again with /goal when you are ready.");
    }
    const goalId = await createGoal(db, user.id, state.goal, now.toISOString());
    await clearConversationState(db, user.id);
    return showGoalDetails({ db, user, goalId, googleTasks });
  }
  const goalLevel = identifier.match(/^goal_level\|(life_vision|annual|quarterly|monthly|weekly)$/);
  if (goalLevel) {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "goal_level") {
      return response("Goal interview expired", "Start again with /goal when you are ready.");
    }
    state.level = goalLevel[1];
    const parents = await listGoalParents(db, user.id, state.level);
    if (parents.length) {
      state.type = "goal_parent";
      await setConversationState(db, user.id, state, now.toISOString());
      return {
        category: "Goal setup",
        title: "Link a parent objective?",
        sections: [{
          heading: "",
          lines: ["This is optional. Choose the active objective this goal supports, or continue without a parent."]
        }],
        actions: [
          ...parents.map(parent => [{
            label: `${parent.title.slice(0, 40)}`,
            action: `goal_parent|${parent.id}`
          }]),
          [{ label: "Continue without parent", action: "goal_parent|skip" }]
        ]
      };
    }
    state.type = "goal_category";
    await setConversationState(db, user.id, state, now.toISOString());
    return goalQuestion("Choose a category", "For example: Work, Health, Learning, Finance, or Relationships.", "Category or skip");
  }
  if (identifier.startsWith("goal_parent|")) {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "goal_parent") {
      return response("Goal interview expired", "Start again with /goal when you are ready.");
    }
    const parentId = identifier.slice("goal_parent|".length);
    if (parentId !== "skip") {
      const parents = await listGoalParents(db, user.id, state.level);
      if (!parents.some(parent => parent.id === parentId)) {
        return response("Parent objective unavailable", "Choose one of the listed active parent objectives or continue without one.");
      }
      state.parentGoalId = parentId;
    }
    state.type = "goal_category";
    await setConversationState(db, user.id, state, now.toISOString());
    return goalQuestion("Choose a category", "For example: Work, Health, Learning, Finance, or Relationships.", "Category or skip");
  }
  if (identifier === "goal_add_key_result") {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "goal_more_key_results") {
      return response("Goal interview expired", "Start again with /goal when you are ready.");
    }
    state.type = "goal_key_result";
    await setConversationState(db, user.id, state, now.toISOString());
    return goalQuestion(
      `Key result ${state.keyResults.length + 1}`,
      "Describe a measurable result as: Measure | baseline | target | unit. Example: Weekly workouts | 0 | 3 | sessions.",
      "Measure | baseline | target | unit"
    );
  }
  if (identifier === "goal_finish_key_results") {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "goal_more_key_results" || !state.keyResults.length) {
      return response("Add a key result first", "A goal needs at least one measurable key result.");
    }
    state.type = "goal_next_action";
    await setConversationState(db, user.id, state, now.toISOString());
    return goalQuestion("Choose the next action", "What is the smallest concrete step that moves this objective forward?", "One next action");
  }
  const goalLinkStart = identifier.match(/^goal_link_start\|(GOAL-[A-Za-z0-9-]{1,48})$/);
  if (goalLinkStart) return beginGoalTaskLink({ db, user, googleTasks, goalId: goalLinkStart[1], now });
  const goalLinkTask = identifier.match(/^goal_select_task\|(TASK-[A-Za-z0-9-]{1,48})$/);
  if (goalLinkTask) {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "goal_task_link") {
      return response("Task selection expired", "Open the objective again to link a task.");
    }
    const linked = await linkGoalTask(db, user.id, state.goalId, goalLinkTask[1], now.toISOString());
    await clearConversationState(db, user.id);
    if (!linked) {
      return response("Task not linked", "Only an open Google Task can be linked. Refresh the objective and try again.");
    }
    return showGoalDetails({ db, user, goalId: state.goalId, googleTasks });
  }
  const goalOpen = identifier.match(/^goal_open\|(GOAL-[A-Za-z0-9-]{1,48})$/);
  if (goalOpen) return showGoalDetails({ db, user, goalId: goalOpen[1], googleTasks });
  const goalProgress = identifier.match(/^goal_update\|(GKR-[A-Za-z0-9-]{1,48})$/);
  if (goalProgress) {
    const keyResult = await getGoalKeyResult(db, user.id, goalProgress[1]);
    if (!keyResult || keyResult.status !== "Active") {
      return response("Progress update unavailable", "This key result is not attached to an active objective.");
    }
    await setConversationState(db, user.id, {
      type: "goal_update_progress",
      goalId: keyResult.goal_id,
      keyResultId: goalProgress[1]
    }, now.toISOString());
    return goalQuestion(
      "Update key result",
      `${keyResult.title}\nCurrent value: ${keyResult.current_value} ${keyResult.unit}\nEnter the new measured value.`,
      "Number only"
    );
  }
  const calendarBlock = identifier.match(/^calendar_block\|(TASK-[A-Za-z0-9-]{1,48})$/);
  if (calendarBlock) {
    if (!googleCalendar || !googleCalendar.createTaskBlock) {
      return response(
        "Calendar integration disabled",
        "Calendar event creation is not authorized, so no event was created."
      );
    }
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    await syncTaskList({ db, googleTasks, now });
    const task = await db.prepare(
      "SELECT id, google_task_id, title, status FROM tasks WHERE id = ?1"
    ).bind(calendarBlock[1]).first();
    if (!task || task.status !== "Pending") {
      return response("Task is not open", "Only an open Google Task can be scheduled.");
    }
    await setConversationState(db, user.id, {
      type: "calendar_block_start",
      taskId: task.id,
      title: task.title,
      requestId: `CAL-${crypto.randomUUID()}`
    }, now.toISOString());
    return {
      category: "Calendar block",
      title: "Choose when to work on it",
      sections: [{
        heading: task.title,
        lines: ["Reply with a Cairo-local start time, for example 11/25/2026 2:30 PM"]
      }],
      inputMode: "force_reply",
      inputPlaceholder: "2026-11-23 09:00"
    };
  }
  const calendarDuration = identifier.match(/^calendar_duration\|(TASK-[A-Za-z0-9-]{1,48})\|(25|50)$/);
  if (calendarDuration) {
    const [, taskId, duration] = calendarDuration;
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!googleCalendar || !googleCalendar.createTaskBlock ||
        !state || state.type !== "calendar_block_duration" ||
        state.taskId !== taskId || !state.date || !state.startTime) {
      return response("Calendar block expired", "Start scheduling again from the task.");
    }
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    await syncTaskList({ db, googleTasks, now });
    const task = await db.prepare(
      "SELECT title, status FROM tasks WHERE id = ?1"
    ).bind(taskId).first();
    if (!task || task.status !== "Pending") {
      await clearConversationState(db, user.id);
      return response("Task is not open", "Only an open Google Task can be scheduled.");
    }
    const event = await googleCalendar.createTaskBlock({
      idempotencyKey: state.requestId,
      title: `Focus: ${task.title}`,
      date: state.date,
      startTime: state.startTime,
      durationMinutes: Number(duration),
      description: `Focused work block for Google Task ${task.title}.`,
      notBefore: now.toISOString()
    });
    if (!event || !event.id || !event.start || !event.end) {
      throw new Error("Google Calendar returned a focus block without its event details.");
    }
    const savedBlock = await db.prepare(
      `INSERT INTO calendar_blocks (
         id, task_id, calendar_request_id, google_event_id, title,
         start_at, end_at, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(calendar_request_id) DO NOTHING`
    ).bind(
      `BLOCK-${state.requestId}`,
      taskId,
      state.requestId,
      event.id,
      task.title,
      event.start.dateTime,
      event.end.dateTime,
      now.toISOString()
    ).run();
    await clearConversationState(db, user.id);
    if (savedBlock.meta && savedBlock.meta.changes === 1) {
      await logSyncEvent(db, {
        source: "Google Calendar",
        operation: "Create focus block",
        occurredAt: now.toISOString(),
        result: "Success",
        relatedRecordId: event.id
      });
    }
    return {
      category: "Calendar block",
      title: "Focus time scheduled",
      sections: [{
        heading: task.title,
        lines: [
          `${state.date} at ${state.startTime} Cairo time`,
          `${duration}-minute block added to Google Calendar.`
        ]
      }],
      actions: [[{ label: "Back to home", action: "home" }]]
    };
  }
  if (identifier === "weekly_unfinished") {
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    await syncTaskList({ db, googleTasks, now });
    const tasks = await listPendingTaskMirrors(db, cairoDateKey(now), 12, 0);
    return {
      category: "Weekly review",
      title: "Open next actions",
      sections: [{
        heading: "",
        lines: tasks.length
          ? tasks.map(task => `${task.title}${task.due_date ? ` — ${task.due_date}` : ""}`)
          : ["There are no pending tasks."]
      }],
      actions: [[{ label: "Back to home", action: "home" }]]
    };
  }
  const monthlyDecision = identifier.match(/^monthly_decision\|(continue|change|pause|kill)$/);
  if (monthlyDecision) {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "monthly_project_decision") {
      return response("Monthly review expired", "Start the monthly project review again.");
    }
    state.type = "monthly_project_reason";
    state.decision = monthlyDecision[1];
    await setConversationState(db, user.id, state, now.toISOString());
    return {
      category: "Monthly project review",
      title: "Record the decision reason",
      sections: [{ heading: state.project, lines: [`Decision: ${state.decision}`] }],
      inputMode: "force_reply",
      inputPlaceholder: "Why this decision?"
    };
  }

  const outcomeStart = identifier.match(/^(?:start_outcome|outcome_start)\|(?:(\d{4}-\d{2}-\d{2})\|)?(DEEP|WORK|LIFE)$/);
  if (outcomeStart) {
    const date = outcomeStart[1] || cairoDateKey(now);
    const area = outcomeStart[2];
    if (!isValidDateKey(date)) return response("Invalid outcome date", "Choose a valid date and try again.");
    const outcome = await getDailyOutcome(db, date, area);
    if (!outcome) {
      await setConversationState(db, user.id, {
        type: "outcome_define",
        date,
        area
      }, now.toISOString());
      return {
        category: "Daily outcome",
        title: `Set your ${area} outcome`,
        sections: [{ heading: "", lines: ["What does done look like, and when will you do it?"] }],
        inputMode: "force_reply",
        inputPlaceholder: "Describe one outcome for today"
      };
    }
    return beginOutcomeSprint({ db, user, outcome, now });
  }

  const focusDuration = identifier.match(/^focus_duration\|(\d{4}-\d{2}-\d{2})\|(DEEP|WORK|LIFE)\|(25|50)$/);
  if (focusDuration) {
    const [, date, area, duration] = focusDuration;
    if (!isValidDateKey(date)) return response("Invalid outcome date", "Choose a valid date and try again.");
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "focus_duration" || state.date !== date || state.area !== area) {
      return response("Focus choice expired", "Start the outcome again to choose a focus block.");
    }
    const dueAt = new Date(now.getTime() + Number(duration) * 60_000);
    const sessionId = `FOCUS-${crypto.randomUUID()}`;
    await recordFocusSession(db, {
      id: sessionId,
      userId: user.id,
      chatId: message.conversation.externalId,
      date,
      area,
      googleTaskId: state.googleTaskId || null,
      nextAction: state.nextAction || "",
      durationMinutes: Number(duration),
      startedAt: now.toISOString(),
      dueAt: dueAt.toISOString()
    });
    await clearConversationState(db, user.id);
    return {
      category: "Focus block",
      title: `${duration}-minute ${area} focus block started`,
      sections: [{
        heading: "",
        lines: [
          `Next action: ${state.nextAction}`,
          `I’ll follow up around ${formatCairoTime(dueAt)}. Your outcome remains open until you explicitly report its result.`
        ]
      }],
      actions: [[{ label: "Back to home", action: "home" }]]
    };
  }

  const focusResult = identifier.match(/^focus\|([A-Za-z0-9-]{1,48})\|(Done|Partial|Blocked|Reschedule)$/);
  if (focusResult) {
    const [, sessionId, choice] = focusResult;
    const session = await getFocusSession(db, sessionId);
    if (!session || session.followup_status !== "Sent" || session.response_status) {
      return response("Focus follow-up already handled", "This focus block is already closed or no longer available.");
    }
    const claim = await claimFocusSessionResponse(db, sessionId, now);
    if (!claim) return response("Focus follow-up already handled", "This focus block is already being handled.");

    try {
      if (choice === "Reschedule") {
        await setConversationState(db, user.id, {
          type: "outcome_reschedule",
          focusSessionId: session.id,
          date: session.outcome_date,
          area: session.area
        }, now.toISOString());
        await finalizeFocusSessionResponse(db, session.id, "ReschedulePending", "", now);
        return {
          category: "Reschedule focus",
          title: "Choose a new task due date",
          sections: [{
            heading: "",
            lines: [
              "Reply with a date like 11/25/2026 or Nov 25.",
              "The task due date will move in Google Tasks. A Calendar block is not created by this Worker yet."
            ]
          }],
          inputMode: "force_reply",
          inputPlaceholder: "11/25/2026"
        };
      }
      if (choice === "Blocked") {
        await finalizeFocusSessionResponse(db, session.id, "BlockedPending", "", now);
        return {
          category: "Focus blocked",
          title: "What is blocking it?",
          sections: [],
          actions: [[
            { label: "Unclear next step", action: `fr|${session.id}|unclear` },
            { label: "Missing information", action: `fr|${session.id}|information` }
          ], [
            { label: "Low energy", action: `fr|${session.id}|energy` },
            { label: "External dependency", action: `fr|${session.id}|external` }
          ]]
        };
      }

      if (choice === "Done" && session.google_task_id) {
        if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
        const task = await db.prepare(
          "SELECT status FROM tasks WHERE google_task_id = ?1"
        ).bind(session.google_task_id).first();
        if (task && task.status === "Pending") {
          const completedTask = await googleTasks.complete(session.google_task_id);
          await upsertGoogleTaskMirror(db, completedTask, now.toISOString());
          await logSyncEvent(db, {
            source: "Google Tasks",
            operation: "Complete focus outcome task",
            occurredAt: now.toISOString(),
            result: "Success",
            relatedRecordId: session.google_task_id
          });
        }
      }
      const outcome = await getDailyOutcome(db, session.outcome_date, session.area);
      if (!outcome) throw new Error("The daily outcome for this focus block could not be found.");
      const outcomeStatus = choice === "Done" ? "Completed" : "Partial";
      await appendOutcomeIfChanged(
        db, outcome, outcomeStatus, "User explicitly confirmed the focus-block result.", now
      );
      await finalizeFocusSessionResponse(db, session.id, outcomeStatus, "", now);
      return {
        category: choice === "Done" ? "Outcome completed" : "Outcome partially complete",
        title: choice === "Done" ? `${session.area} outcome marked done` : `${session.area} outcome marked partly done`,
        sections: [{
          heading: "",
          lines: [choice === "Done" ? "Your confirmation is recorded." : "Choose one useful next step."]
        }],
        actions: choice === "Done"
          ? [[{ label: "Back to home", action: "home" }]]
          : [[
              { label: "Start another sprint", action: `outcome_start|${session.outcome_date}|${session.area}` },
              { label: "Mark blocked", action: `outcome_status|${session.outcome_date}|${session.area}|Blocked` }
            ]]
      };
    } catch (error) {
      await releaseFocusSessionResponse(db, session.id);
      throw error;
    }
  }

  const focusReason = identifier.match(/^fr\|([A-Za-z0-9-]{1,48})\|(unclear|information|energy|external)$/);
  if (focusReason) {
    const [, sessionId, reasonKey] = focusReason;
    const session = await getFocusSession(db, sessionId);
    if (!session || session.response_status !== "BlockedPending") {
      return response("Focus follow-up expired", "This blocker choice is no longer available.");
    }
    const claim = await claimFocusSessionResponse(db, sessionId, now, "BlockedPending");
    if (!claim) return response("Focus follow-up already handled", "This blocker choice is already being handled.");
    const reasons = {
      unclear: "Unclear next step",
      information: "Missing information",
      energy: "Low energy",
      external: "External dependency"
    };
    try {
      const outcome = await getDailyOutcome(db, session.outcome_date, session.area);
      if (!outcome) throw new Error("The daily outcome for this focus block could not be found.");
      await appendOutcomeIfChanged(db, outcome, "Blocked", reasons[reasonKey], now);
      await finalizeFocusSessionResponse(db, session.id, "Blocked", reasons[reasonKey], now);
      return {
        category: "Outcome blocked",
        title: "Blocker recorded",
        sections: [{ heading: "", lines: [reasons[reasonKey], "This can inform your weekly review."] }],
        actions: [[{ label: "Back to home", action: "home" }]]
      };
    } catch (error) {
      await releaseFocusSessionResponse(db, session.id);
      throw error;
    }
  }

  const outcomeStatus = identifier.match(/^outcome_status\|(\d{4}-\d{2}-\d{2})\|(DEEP|WORK|LIFE)\|(Completed|Partial|Blocked)$/);
  if (outcomeStatus) {
    const [, date, area, status] = outcomeStatus;
    const outcome = await getDailyOutcome(db, date, area);
    if (!outcome) return response("Outcome not found", `There is no ${area} outcome for ${date}.`);
    if (["Completed", "Dropped"].includes(outcome.status)) {
      return response("Outcome already closed", `The ${area} outcome is already ${outcome.status.toLowerCase()}.`);
    }
    if (status === "Blocked") {
      return {
        category: "Outcome blocked",
        title: "What is blocking it?",
        sections: [],
        actions: [
          [
            { label: "Unclear next step", action: `outcome_block_reason|${date}|${area}|unclear` },
            { label: "Missing information", action: `outcome_block_reason|${date}|${area}|information` }
          ],
          [
            { label: "Low energy", action: `outcome_block_reason|${date}|${area}|energy` },
            { label: "External dependency", action: `outcome_block_reason|${date}|${area}|external` }
          ]
        ]
      };
    }
    if (status === "Completed" && outcome.google_task_id) {
      if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
      const task = await db.prepare(
        `SELECT status FROM tasks WHERE google_task_id = ?1`
      ).bind(outcome.google_task_id).first();
      if (task && task.status === "Pending") {
        const completedTask = await googleTasks.complete(outcome.google_task_id);
        await upsertGoogleTaskMirror(db, completedTask, now.toISOString());
        await logSyncEvent(db, {
          source: "Google Tasks",
          operation: "Complete outcome task",
          occurredAt: now.toISOString(),
          result: "Success",
          relatedRecordId: outcome.google_task_id
        });
      }
    }
    await appendDailyOutcomeStatus(db, outcome, status, "User explicitly confirmed the outcome status.", now);
    if (status === "Completed") {
      return {
        category: "Outcome completed",
        title: `${area} outcome marked done`,
        sections: [{ heading: "", lines: ["Your confirmation is recorded."] }],
        actions: [[{ label: "Back to home", action: "home" }]]
      };
    }
    return {
      category: "Outcome partially complete",
      title: `${area} outcome marked partly done`,
      sections: [{ heading: "", lines: ["Choose one useful next step."] }],
      actions: [[
        { label: "Start another sprint", action: `outcome_start|${date}|${area}` },
        { label: "Mark blocked", action: `outcome_status|${date}|${area}|Blocked` }
      ], [
        { label: "Drop outcome", action: `outcome_drop|${date}|${area}` }
      ]]
    };
  }

  const blockReason = identifier.match(/^outcome_block_reason\|(\d{4}-\d{2}-\d{2})\|(DEEP|WORK|LIFE)\|(unclear|information|energy|external)$/);
  if (blockReason) {
    const [, date, area, reasonKey] = blockReason;
    const outcome = await getDailyOutcome(db, date, area);
    if (!outcome) return response("Outcome not found", `There is no ${area} outcome for ${date}.`);
    if (["Completed", "Dropped"].includes(outcome.status)) {
      return response("Outcome already closed", `The ${area} outcome is already ${outcome.status.toLowerCase()}.`);
    }
    const reasons = {
      unclear: "Unclear next step",
      information: "Missing information",
      energy: "Low energy",
      external: "External dependency"
    };
    await appendDailyOutcomeStatus(db, outcome, "Blocked", reasons[reasonKey], now);
    return {
      category: "Outcome blocked",
      title: "Blocker recorded",
      sections: [{ heading: "", lines: [reasons[reasonKey], "This can inform your weekly review."] }],
      actions: [[{ label: "Drop outcome with reason", action: `outcome_drop|${date}|${area}` }],
        [{ label: "Back to home", action: "home" }]]
    };
  }

  const outcomeDrop = identifier.match(/^outcome_drop\|(\d{4}-\d{2}-\d{2})\|(DEEP|WORK|LIFE)$/);
  if (outcomeDrop) {
    const [, date, area] = outcomeDrop;
    const outcome = await getDailyOutcome(db, date, area);
    if (!outcome) return response("Outcome not found", `There is no ${area} outcome for ${date}.`);
    if (["Completed", "Dropped"].includes(outcome.status)) {
      return response("Outcome already closed", `The ${area} outcome is already ${outcome.status.toLowerCase()}.`);
    }
    await setConversationState(db, user.id, {
      type: "outcome_drop",
      date,
      area
    }, now.toISOString());
    return {
      category: "Drop outcome",
      title: "Drop this outcome",
      sections: [{ heading: "", lines: ["Reply with a short reason. The related Google Task will remain pending."] }],
      inputMode: "force_reply",
      inputPlaceholder: "Why are you dropping this outcome?"
    };
  }

  const area = identifier.match(/^task_area\|(DEEP|WORK|LIFE|Admin|Other)$/);
  if (area) {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "task_area") {
      return response("Task capture expired", "Start again with /addtask.");
    }
    state.area = area[1];
    state.type = "task_priority";
    await setConversationState(db, user.id, state, now.toISOString());
    return {
      category: "Task capture",
      title: "Choose priority",
      sections: [],
      actions: [[
        { label: "High", action: "task_priority|High" },
        { label: "Medium", action: "task_priority|Medium" },
        { label: "Low", action: "task_priority|Low" }
      ]]
    };
  }

  const priority = identifier.match(/^task_priority\|(High|Medium|Low)$/);
  if (priority) {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "task_priority") {
      return response("Task capture expired", "Start again with /addtask.");
    }
    state.priority = priority[1];
    state.type = "task_due";
    await setConversationState(db, user.id, state, now.toISOString());
    return {
      category: "Task capture",
      title: "When is this due?",
      sections: [],
      actions: [[
        { label: "Today", action: "task_due|today" },
        { label: "Tomorrow", action: "task_due|tomorrow" },
        { label: "No deadline", action: "task_due|none" }
      ]]
    };
  }

  const due = identifier.match(/^task_due\|(today|tomorrow|none)$/);
  if (due) {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "task_due") {
      return response("Task capture expired", "Start again with /addtask.");
    }
    state.dueDate = due[1] === "today"
      ? cairoDateKey(now)
      : due[1] === "tomorrow" ? shiftDateKey(cairoDateKey(now), 1) : "";
    state.type = "task_done_test";
    await setConversationState(db, user.id, state, now.toISOString());
    return {
      category: "Task capture",
      title: "What would count as done?",
      sections: [],
      inputMode: "force_reply",
      inputPlaceholder: "Describe the finished result"
    };
  }

  const top3 = identifier.match(/^task_top3\|(yes|no)$/);
  if (top3) {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (!state || state.type !== "task_top3") {
      return response("Task capture expired", "Start again with /addtask.");
    }
    return createCapturedTask({
      db, user, state,
      addToTop3: top3[1] === "yes",
      googleTasks, googleCalendar, now
    });
  }

  const completion = identifier.match(/^task_complete\|([^|]+)$/);
  if (completion) {
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    const googleTaskId = completion[1];
    const existing = await db.prepare(
      `SELECT id, status
         FROM tasks
        WHERE google_task_id = ?1`
    ).bind(googleTaskId).first();
    if (!existing || existing.status !== "Pending") {
      return response("Task completion rejected", "This task is no longer pending.");
    }

    const completedTask = await googleTasks.complete(googleTaskId);
    await upsertGoogleTaskMirror(db, completedTask, now.toISOString());
    await db.prepare(
      `UPDATE reminder_history
          SET user_response = 'Completed', confirmed_at = ?1
        WHERE related_record_id = ?2 AND category = 'Overdue task'
          AND delivery_status = 'Sent' AND user_response IS NULL`
    ).bind(now.toISOString(), existing.id).run();
    await logSyncEvent(db, {
      source: "Google Tasks",
      operation: "Complete task",
      occurredAt: now.toISOString(),
      result: "Success",
      relatedRecordId: googleTaskId
    });
    return {
      category: "Task completion",
      title: "Task marked complete in Google Tasks",
      sections: [],
      actions: [[{ label: "Show open tasks", action: "show_tasks" }]]
    };
  }

  return response("Unsupported action", "That action is not migrated yet.");
}

async function beginTaskCapture(db, user, now) {
  await setConversationState(db, user.id, { type: "task_title" }, now.toISOString());
  return {
    category: "Task capture",
    title: "Add a task",
    sections: [{ heading: "", lines: ["What is the next action you want to capture?"] }],
    inputMode: "force_reply",
    inputPlaceholder: "Write one clear next action"
  };
}

async function beginGoalCapture(db, user, now) {
  await setConversationState(db, user.id, {
    type: "goal_title",
    startDate: cairoDateKey(now),
    keyResults: []
  }, now.toISOString(), 7200);
  return goalQuestion(
    "Create a goal",
    "What is one meaningful objective you want to work toward? I will not invent goals for you.",
    "Objective title"
  );
}

async function showGoals({ db, user }) {
  const goals = await listGoals(db, user.id);
  if (!goals.length) {
    return {
      category: "Goals",
      title: "No objectives defined yet",
      sections: [{ heading: "", lines: ["The assistant will not invent your goals. Start an interview to define one in your own words."] }],
      actions: [[{ label: "Start goal interview", action: "goal_new" }]]
    };
  }
  const visibleGoals = goals.slice(0, 8);
  const lines = visibleGoals.map(goal => {
    const level = formatGoalLevel(goal.level);
    const progress = goal.progress_fraction == null
      ? "progress not measured"
      : `${Math.round(goal.progress_fraction * 100)}% measured progress`;
    const parent = goal.parent_title ? ` → ${goal.parent_title}` : "";
    const deadline = goal.deadline ? ` · due ${goal.deadline}` : "";
    return `${level}: ${goal.title}${parent}\n${progress}${deadline}\nNext: ${goal.next_action}`;
  });
  return {
    category: "Goals",
    title: "Active objectives",
    sections: [{ heading: "", lines }],
    actions: [
      ...visibleGoals.map(goal => [{
        label: `Open · ${goal.title.slice(0, 36)}`,
        action: `goal_open|${goal.id}`
      }]),
      [{ label: "Define another goal", action: "goal_new" }]
    ]
  };
}

async function showGoalDetails({ db, user, goalId, googleTasks = null }) {
  const goal = await getGoal(db, user.id, goalId);
  if (!goal) return response("Goal not found", "This objective is unavailable for your account.");
  const [keyResults, projects, linkedTasks] = await Promise.all([
    getGoalKeyResults(db, goalId),
    getGoalProjects(db, goalId),
    getGoalTaskLinks(db, user.id, goalId)
  ]);
  const progress = goal.progress_fraction == null
    ? "Not measured yet"
    : `${Math.round(goal.progress_fraction * 100)}%`;
  const summary = [
    `Level: ${formatGoalLevel(goal.level)}${goal.parent_title ? ` · supports ${goal.parent_title}` : ""}`,
    `Category: ${goal.category || "Not set"} · Status: ${goal.status}`,
    `Why: ${goal.why_matters}`,
    `Target: ${goal.target_outcome}`,
    `Started: ${goal.start_date}${goal.deadline ? ` · Deadline: ${goal.deadline}` : ""}`,
    `Progress: ${progress}`,
    `Next action: ${goal.next_action}`,
    ...(projects.length ? [`Related project: ${projects.join(", ")}`] : [])
  ];
  const sections = [{ heading: goal.title, lines: summary }];
  const actions = [];
  if (linkedTasks.length) {
    sections.push({
      heading: "Linked tasks",
      lines: linkedTasks.slice(0, 8).map(task =>
        `${task.title} · ${task.status}${task.due_date ? ` · due ${task.due_date}` : ""}`
      )
    });
  }
  if (keyResults.length) {
    sections.push({
      heading: "Key results",
      lines: keyResults.map(item => {
        const resultProgress = calculateKeyResultProgress(item);
        const progressText = resultProgress == null ? "" : ` · ${Math.round(resultProgress * 100)}%`;
        return `${item.title}: ${item.current_value} / ${item.target_value} ${item.unit}${progressText}`;
      })
    });
    for (const item of keyResults.slice(0, 5)) {
      actions.push([{
        label: `Update · ${item.title.slice(0, 32)}`,
        action: `goal_update|${item.id}`
      }]);
    }
  }
  if (goal.status === "Active" && googleTasks) {
    actions.push([{ label: "Link an open task", action: `goal_link_start|${goal.id}` }]);
  }
  actions.push([{ label: "All goals", action: "goals_show" }]);
  return {
    category: "Goal details",
    title: goal.title,
    sections,
    actions
  };
}

async function beginGoalTaskLink({ db, user, googleTasks, goalId, now }) {
  const goal = await getGoal(db, user.id, goalId);
  if (!goal || goal.status !== "Active") {
    return response("Goal unavailable", "Only an active objective can be linked to tasks.");
  }
  if (!googleTasks) {
    return response("Google Tasks unavailable", "Task linking needs the configured Google Tasks integration.");
  }
  await syncTaskList({ db, googleTasks, now });
  const [linkedTasks, tasks] = await Promise.all([
    getGoalTaskLinks(db, user.id, goalId),
    listPendingTaskMirrors(db, cairoDateKey(now), 20, 0)
  ]);
  const linkedIds = new Set(linkedTasks.map(task => task.id));
  const candidates = tasks.filter(task => !linkedIds.has(task.id));
  if (!candidates.length) {
    return response("No open tasks to link", "Create or reopen a task in Google Tasks, then try linking again.");
  }
  await setConversationState(db, user.id, { type: "goal_task_link", goalId }, now.toISOString());
  return {
    category: "Goal task link",
    title: "Choose an open Google Task",
    sections: [{ heading: goal.title, lines: ["Linking records the relationship only; it does not change task status."] }],
    actions: [
      ...candidates.map(task => [{
        label: task.title.slice(0, 50),
        action: `goal_select_task|${task.id}`
      }]),
      [{ label: "Cancel", action: "goal_link_cancel" }]
    ]
  };
}

function goalQuestion(title, question, inputPlaceholder) {
  return {
    category: "Goal setup",
    title,
    sections: [{ heading: "", lines: [question] }],
    inputMode: "force_reply",
    inputPlaceholder
  };
}

function formatGoalLevel(level) {
  return ({
    life_vision: "Life vision",
    annual: "Annual objective",
    quarterly: "Quarterly objective",
    monthly: "Monthly milestone",
    weekly: "Weekly outcome"
  })[level] || level;
}

function calculateKeyResultProgress(keyResult) {
  const { baseline_value: baseline, current_value: current, target_value: target } = keyResult;
  const span = target - baseline;
  if (!span) return null;
  const progress = span > 0 ? (current - baseline) / span : (baseline - current) / -span;
  return Math.min(1, Math.max(0, progress));
}

function parseGoalKeyResult(text) {
  const parts = text.split("|").map(part => part.trim());
  if (parts.length !== 4 || parts.some(part => !part)) return null;
  const baselineValue = Number(parts[1]);
  const targetValue = Number(parts[2]);
  if (
    !parts[0] ||
    parts[0].length > 160 ||
    parts[3].length > 40 ||
    !Number.isFinite(baselineValue) ||
    !Number.isFinite(targetValue) ||
    baselineValue === targetValue
  ) return null;
  return { title: parts[0], baselineValue, targetValue, unit: parts[3] };
}

async function handleGoalConversationText({ db, user, state, text, googleTasks, now }) {
  if (state.type === "goal_title") {
    if (text.length > 180) return response("Title too long", "Keep the objective title under 180 characters.");
    state.title = text;
    state.type = "goal_level";
    await setConversationState(db, user.id, state, now.toISOString());
    return {
      category: "Goal setup",
      title: "Choose the time horizon",
      sections: [{ heading: state.title, lines: ["Pick the level that best fits. A goal can be linked to an active parent objective next."] }],
      actions: [
        [{ label: "Life vision", action: "goal_level|life_vision" }],
        [{ label: "Annual", action: "goal_level|annual" }],
        [{ label: "Quarterly", action: "goal_level|quarterly" }],
        [{ label: "Monthly", action: "goal_level|monthly" }],
        [{ label: "Weekly", action: "goal_level|weekly" }]
      ]
    };
  }
  if (state.type === "goal_category") {
    if (text.length > 80) return response("Category too long", "Keep the category under 80 characters, or type skip.");
    state.category = text.toLowerCase() === "skip" ? "" : text;
    state.type = "goal_project";
    await setConversationState(db, user.id, state, now.toISOString());
    return goalQuestion("Related project", "If this objective belongs to a project, name it. Otherwise type skip.", "Project name or skip");
  }
  if (state.type === "goal_project") {
    if (text.length > 160) return response("Project name too long", "Keep the project name under 160 characters, or type skip.");
    state.projectName = text.toLowerCase() === "skip" ? "" : text;
    state.type = "goal_description";
    await setConversationState(db, user.id, state, now.toISOString());
    return goalQuestion("Describe the objective", "Add useful context in a sentence or two, or type skip.", "Short description or skip");
  }
  if (state.type === "goal_description") {
    if (text.length > 600) return response("Description too long", "Keep the description under 600 characters, or type skip.");
    state.description = text.toLowerCase() === "skip" ? "" : text;
    state.type = "goal_why";
    await setConversationState(db, user.id, state, now.toISOString());
    return goalQuestion("Why does it matter?", "What makes this objective important to you?", "Your reason");
  }
  if (state.type === "goal_why") {
    if (text.length > 600) return response("Answer too long", "Keep the reason under 600 characters.");
    state.whyMatters = text;
    state.type = "goal_target";
    await setConversationState(db, user.id, state, now.toISOString());
    return goalQuestion("Define the target outcome", "What observable result would tell you this objective has succeeded?", "Measurable outcome");
  }
  if (state.type === "goal_target") {
    if (text.length > 600) return response("Target too long", "Keep the target outcome under 600 characters.");
    state.targetOutcome = text;
    state.type = "goal_deadline";
    await setConversationState(db, user.id, state, now.toISOString());
    return goalQuestion("Set a deadline", "Enter a date like 11/25/2026, Nov 25, or type none.", "11/25/2026 or none");
  }
  if (state.type === "goal_deadline") {
    const deadline = text.toLowerCase() === "none" ? null : parseDateInput(text, now);
    if (text.toLowerCase() !== "none" && (!deadline || deadline < state.startDate)) {
      return response("Invalid deadline", "Use 11/25/2026 or Nov 25 on or after the start date, or type none.");
    }
    state.deadline = deadline;
    state.type = "goal_key_result";
    await setConversationState(db, user.id, state, now.toISOString());
    return goalQuestion(
      "Add a measurable key result",
      "Use: Measure | baseline | target | unit. Example: Weekly workouts | 0 | 3 | sessions.",
      "Measure | baseline | target | unit"
    );
  }
  if (state.type === "goal_key_result") {
    const keyResult = parseGoalKeyResult(text);
    if (!keyResult) {
      return response(
        "Key result format",
        "Enter four parts separated by |, with numeric baseline and target values that differ. Example: Weekly workouts | 0 | 3 | sessions."
      );
    }
    state.keyResults.push(keyResult);
    state.type = "goal_more_key_results";
    await setConversationState(db, user.id, state, now.toISOString());
    const actions = state.keyResults.length < 5
      ? [[{ label: "Add another", action: "goal_add_key_result" }, { label: "Continue", action: "goal_finish_key_results" }]]
      : [[{ label: "Continue", action: "goal_finish_key_results" }]];
    return {
      category: "Goal setup",
      title: "Key result recorded",
      sections: [{ heading: keyResult.title, lines: [`Baseline: ${keyResult.baselineValue} · Target: ${keyResult.targetValue} ${keyResult.unit}`] }],
      actions
    };
  }
  if (state.type === "goal_next_action") {
    if (text.length > 300) return response("Next action too long", "Keep the next action under 300 characters.");
    state.goal = {
      parentGoalId: state.parentGoalId || null,
      level: state.level,
      title: state.title,
      description: state.description || "",
      category: state.category || "",
      projectName: state.projectName || "",
      whyMatters: state.whyMatters,
      targetOutcome: state.targetOutcome,
      startDate: state.startDate,
      deadline: state.deadline,
      nextAction: text,
      keyResults: state.keyResults
    };
    state.type = "goal_confirm";
    await setConversationState(db, user.id, state, now.toISOString());
    return {
      category: "Goal confirmation",
      title: "Save this objective?",
      sections: [{
        heading: state.title,
        lines: [
          `Level: ${formatGoalLevel(state.level)}`,
          `Category: ${state.category || ""}${state.projectName ? ` · Project: ${state.projectName}` : ""}`.trim(),
          `Why: ${state.whyMatters}`,
          `Target: ${state.targetOutcome}`,
          ...(state.deadline ? [`Deadline: ${shortDate(state.deadline)}`] : []),
          ...state.keyResults.map(result => `Key result: ${result.title} · ${result.baselineValue} → ${result.targetValue} ${result.unit}`),
          `Next action: ${state.goal.nextAction}`
        ]
      }],
      actions: [[
        { label: "Save objective", action: "goal_save" },
        { label: "Cancel", action: "goal_cancel" }
      ]]
    };
  }
  if (state.type === "goal_update_progress") {
    const value = Number(text);
    if (!text || !Number.isFinite(value)) {
      return response("Enter a number", "Send the measured value as a number, for example 4 or 2.5.");
    }
    await updateGoalKeyResult(
      db,
      user.id,
      state.goalId,
      state.keyResultId,
      value,
      now.toISOString()
    );
    await clearConversationState(db, user.id);
    return showGoalDetails({ db, user, goalId: state.goalId, googleTasks });
  }
  return response("Goal interview", "Continue the active goal interview or restart with /goal.");
}

async function beginNextDayPlanning({ db, user, now }) {
  const date = shiftDateKey(cairoDateKey(now), 1);
  const runId = crypto.randomUUID();
  await setConversationState(db, user.id, {
    type: "next_day_done",
    date,
    reviewDate: cairoDateKey(now),
    runId
  }, now.toISOString(), 7200);
  return planningQuestion("Plan tomorrow — 1/5", "What got DONE today?");
}

async function beginWeeklyReview({ db, user, now }) {
  const questions = getWeeklyReviewQuestions();
  const activeGoals = await listGoals(db, user.id);
  await setConversationState(db, user.id, {
    type: "weekly_review",
    index: 0,
    date: cairoDateKey(now),
    runId: crypto.randomUUID()
  }, now.toISOString(), 7200);
  const prompt = planningQuestion(`Weekly review 1/${questions.length}`, questions[0].text);
  return {
    ...prompt,
    sections: [
      { heading: "Goal progress to reflect on", lines: formatGoalReview(activeGoals) },
      ...prompt.sections
    ]
  };
}

async function beginMonthlyProjectReview({ db, user, now }) {
  const activeGoals = await listGoals(db, user.id);
  await setConversationState(db, user.id, {
    type: "monthly_project_name",
    date: cairoDateKey(now),
    runId: crypto.randomUUID()
  }, now.toISOString(), 7200);
  return {
    category: "Monthly project review",
    title: "Choose a project to review",
    sections: [
      { heading: "Goal progress to reflect on", lines: formatGoalReview(activeGoals) },
      { heading: "", lines: ["Every project needs a reason and a review date."] }
    ],
    inputMode: "force_reply",
    inputPlaceholder: "Project name"
  };
}

function formatGoalReview(goals) {
  if (!goals.length) return ["No objectives defined yet. Use /goal when ready; none are assumed."];
  return goals.slice(0, 5).map(goal => {
    const progress = goal.progress_fraction == null
      ? "not measured"
      : `${Math.round(goal.progress_fraction * 100)}% measured progress`;
    const parent = goal.parent_title ? ` · supports ${goal.parent_title}` : "";
    return `${formatGoalLevel(goal.level)}: ${goal.title}${parent} · ${progress}\nNext: ${goal.next_action}`;
  }).concat(goals.length > 5 ? [`${goals.length - 5} more objectives.`] : []);
}

function getWeeklyReviewQuestions() {
  return [
    {
      text: "On how many days did you complete your Growth, Work, and Life outcomes? Which areas felt clear?",
      area: "Growth/Work/Life"
    },
    {
      text: "What repeatedly blocked you? Name the pattern, not a judgment about yourself.",
      area: "Blockers"
    },
    {
      text: "Which open loop should be deleted, delegated, or scheduled?",
      area: "Open loop"
    },
    {
      text: "What is one small experiment for next week?",
      area: "Experiment"
    },
    {
      text: "Which project needs a continue, change, pause, or kill decision?",
      area: "Project"
    }
  ];
}

function planningQuestion(title, question) {
  return {
    category: "Next-day planning",
    title,
    sections: [{ heading: "", lines: [question] }],
    inputMode: "force_reply",
    inputPlaceholder: "One short answer"
  };
}

function forceReply(title, question) {
  return {
    category: "Availability planning",
    title,
    sections: [{ heading: "", lines: [question] }],
    inputMode: "force_reply",
    inputPlaceholder: "One short answer"
  };
}

async function handleConversationText({
  db,
  user,
  message,
  state,
  googleTasks,
  googleCalendar,
  aiDailyPlanner,
  now
}) {
  const text = String(message.message.text || "").trim();
  if (!text) return null;
  if (state.type === "reminder_time_custom") {
    const parsed = parseCairoDateTime(text, now);
    if (!parsed) return {
      category: "Reminder",
      title: "",
      sections: [{ heading: "", lines: ["Enter a date and time, for example 11/25/2026 3:00 PM."] }],
      inputMode: "force_reply",
      inputPlaceholder: "11/25/2026 3:00 PM"
    };
    const due = new Date(cairoDateTimeToUtcForReminder(parsed.dateKey, parsed.time));
    if (due.getTime() <= now.getTime()) return response("Reminder", "That time has passed. Choose a future time.");
    await createUserReminder({
      db, user, text: state.text, dueAtUtc: due.toISOString(), now: now.toISOString()
    });
    await clearConversationState(db, user.id);
    return response("Reminder", `Got it. I'll remind you to “${state.text}” at ${timeLabel(due)}. ⏰`);
  }
  if (state.type === "available_time_duration") {
    if (!/^\d{1,3}$/.test(text)) {
      return forceReply(
        "Free-time duration needed",
        "Enter the number of free minutes, from 25 to 360."
      );
    }
    return beginAvailableTimeRequest({
      db, user, minutes: Number(text), now
    });
  }
  if (state.type === "available_time_start") {
    const parsedTime = parseTimeInput(text);
    if (!parsedTime) {
      return forceReply(
        "Cairo start time needed",
        "Enter today's start time in Cairo, for example 2:30 PM or 14:30."
      );
    }
    return createAvailableTimePlan({
      db,
      user,
      minutes: state.minutes,
      startTime: parsedTime,
      googleTasks,
      googleCalendar,
      aiDailyPlanner,
      now
    });
  }
  if (typeof state.type === "string" && state.type.startsWith("goal_")) {
    return handleGoalConversationText({ db, user, state, text, googleTasks, now });
  }

  if (state.type === "outcome_define") {
    if (text.length > 500) {
      return response("Outcome too long", "Keep the outcome under 500 characters and try again.");
    }
    return createOutcomeAndBeginSprint({ db, user, state, text, googleTasks, now });
  }

  if (state.type === "focus_action") {
    if (text.length > 1000) {
      return response("Focus action too long", "Keep the next action under 1,000 characters and try again.");
    }
    const outcome = await getDailyOutcome(db, state.date, state.area);
    if (!outcome) {
      await clearConversationState(db, user.id);
      return response("Outcome not found", "This outcome is no longer available. Start again from today's plan.");
    }
    await appendDailyOutcomeStatus(db, outcome, "In progress", text, now);
    await setConversationState(db, user.id, {
      type: "focus_duration",
      date: state.date,
      area: state.area,
      nextAction: text,
      googleTaskId: outcome.google_task_id
    }, now.toISOString());
    return {
      category: "Focus block",
      title: "Choose a focus block",
      sections: [{ heading: "", lines: ["What is the smallest visible result you can finish in 25–50 minutes?"] }],
      actions: [[
        { label: "25 minutes", action: `focus_duration|${state.date}|${state.area}|25` },
        { label: "50 minutes", action: `focus_duration|${state.date}|${state.area}|50` }
      ]]
    };
  }

  if (state.type === "outcome_reschedule") {
    const rescheduleDate = parseDateInput(text, now);
    if (!rescheduleDate) {
      return response("Date format needed", "Enter a date like 11/25/2026, 11/25, Nov 25, or tomorrow.");
    }
    if (rescheduleDate < cairoDateKey(now)) {
      return response("Choose a future date", "The new due date cannot be before today in Cairo.");
    }
    const session = await getFocusSession(db, state.focusSessionId);
    if (!session || session.response_status !== "ReschedulePending") {
      await clearConversationState(db, user.id);
      return response("Reschedule expired", "This focus block can no longer be rescheduled.");
    }
    const claim = await claimFocusSessionResponse(db, session.id, now, "ReschedulePending");
    if (!claim) return response("Reschedule already handled", "This focus block is already being rescheduled.");
    try {
      if (session.google_task_id) {
        if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
        const existingTask = await db.prepare(
          "SELECT status FROM tasks WHERE google_task_id = ?1"
        ).bind(session.google_task_id).first();
        if (!existingTask || existingTask.status !== "Pending") {
          await finalizeFocusSessionResponse(db, session.id, "RescheduleRejected", "Task is not pending.", now);
          await clearConversationState(db, user.id);
          return response("Task is not open", "Only a pending Google Task can be rescheduled.");
        }
        const task = await googleTasks.reschedule(session.google_task_id, rescheduleDate);
        await upsertGoogleTaskMirror(db, task, now.toISOString());
        await logSyncEvent(db, {
          source: "Google Tasks",
          operation: "Reschedule focus outcome task",
          occurredAt: now.toISOString(),
          result: "Success",
          relatedRecordId: session.google_task_id
        });
      }
      const outcome = await getDailyOutcome(db, session.outcome_date, session.area);
      if (!outcome) throw new Error("The daily outcome for this focus block could not be found.");
      const details = `Moved to ${rescheduleDate}. Calendar block not created; the Worker Calendar integration is pending.`;
      await appendOutcomeIfChanged(db, outcome, "Rescheduled", details, now);
      await finalizeFocusSessionResponse(db, session.id, "Rescheduled", details, now);
      await clearConversationState(db, user.id);
      return {
        category: "Outcome rescheduled",
        title: "Task due date moved",
        sections: [{
          heading: "",
          lines: [
            `Google Tasks due date: ${shortDate(rescheduleDate)}`,
            "No Calendar block was created. You can add one from Google Calendar until that integration is migrated."
          ]
        }],
        actions: [[{ label: "Back to home", action: "home" }]]
      };
    } catch (error) {
      await releaseFocusSessionResponse(db, session.id);
      throw error;
    }
  }

  if (state.type === "next_day_done") {
    if (text.length > 1000) return response("Answer too long", "Keep this note under 1,000 characters.");
    await recordReviewNote(db, {
      id: `PLAN-${state.runId}-done`,
      reviewType: "Daily shutdown",
      reviewDate: state.reviewDate,
      question: "DONE today",
      answer: text,
      createdAt: now.toISOString()
    });
    await setConversationState(db, user.id, {
      type: "next_day_deep",
      date: state.date,
      reviewDate: state.reviewDate,
      runId: state.runId
    }, now.toISOString());
    return planningQuestion("Plan tomorrow — 2/5", "What is the one Growth outcome?");
  }

  if (state.type === "next_day_deep") {
    if (text.length > 500) return response("Outcome too long", "Keep the Growth outcome under 500 characters.");
    await setConversationState(db, user.id, {
      type: "next_day_work",
      date: state.date,
      reviewDate: state.reviewDate,
      runId: state.runId,
      deep: text
    }, now.toISOString());
    return planningQuestion("Plan tomorrow — 3/5", "What is the one Work / SDR outcome?");
  }

  if (state.type === "next_day_work") {
    if (text.length > 500) return response("Outcome too long", "Keep the Work outcome under 500 characters.");
    await setConversationState(db, user.id, {
      type: "next_day_life",
      date: state.date,
      reviewDate: state.reviewDate,
      runId: state.runId,
      deep: state.deep,
      work: text
    }, now.toISOString());
    return planningQuestion("Plan tomorrow — 4/5", "What is the one Life health or admin outcome?");
  }

  if (state.type === "next_day_life") {
    if (text.length > 500) return response("Outcome too long", "Keep the Life outcome under 500 characters.");
    await setConversationState(db, user.id, {
      type: "next_day_risk",
      date: state.date,
      reviewDate: state.reviewDate,
      runId: state.runId,
      deep: state.deep,
      work: state.work,
      life: text
    }, now.toISOString());
    return planningQuestion("Plan tomorrow — 5/5", "What is the main RISK that could derail the day?");
  }

  if (state.type === "next_day_risk") {
    if (text.length > 1000) return response("Risk note too long", "Keep the risk note under 1,000 characters.");
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    await syncTaskList({ db, googleTasks, now });
    const previousOutcomes = [];
    for (const item of [
      { area: "DEEP", title: state.deep, priority: "High" },
      { area: "WORK", title: state.work, priority: "High" },
      { area: "LIFE", title: state.life, priority: "Medium" }
    ]) {
      const current = await getDailyOutcome(db, state.date, item.area);
      let googleTaskId = "";
      if (current && current.outcome === item.title && current.google_task_id) {
        const existingTask = await db.prepare(
          "SELECT status FROM tasks WHERE google_task_id = ?1"
        ).bind(current.google_task_id).first();
        if (existingTask && existingTask.status === "Pending") {
          googleTaskId = current.google_task_id;
        }
      } else if (current && current.google_task_id) {
        previousOutcomes.push(item.area);
      }

      const requestId = `PLAN-${state.runId}-${item.area}`;
      if (!googleTaskId) {
        const task = await createPlannedOutcomeTask({
          db,
          googleTasks,
          requestId,
          title: item.title,
          area: item.area,
          priority: item.priority,
          dueDate: state.date,
          risk: text,
          now
        });
        googleTaskId = task.id;
      }
      await appendDailyOutcomeFromTask(db, {
        requestId,
        date: state.date,
        area: item.area,
        title: item.title,
        doneTest: "Define the visible result before starting.",
        taskId: googleTaskId,
        statusDetails: `Risk: ${text}`,
        updatedAt: now.toISOString()
      });
    }

    await recordReviewNote(db, {
      id: `PLAN-${state.runId}-risk`,
      reviewType: "Next-day planning",
      reviewDate: state.reviewDate,
      question: "RISK that could derail the day",
      answer: text,
      createdAt: now.toISOString()
    });
    await clearConversationState(db, user.id);
    const planned = await getDailyOutcomesForDate(db, state.date);
    const sections = [
      { heading: "Three outcomes", lines: planned },
      { heading: "Risk", lines: [text] },
      { heading: "", lines: ["Three actionable Google Tasks are ready. Calendar blocks were not created."] },
      { heading: "", lines: ["The 00:00–01:00 planning confirmation remains the final checkpoint."] }
    ];
    if (previousOutcomes.length) {
      sections.push({
        heading: "Previously planned tasks",
        lines: [`Previous ${previousOutcomes.join(", ")} tasks remain pending; review them in your full task list.`]
      });
    }
    return {
      category: "Next-day planning",
      title: "Tomorrow has a clear shape",
      sections,
      actions: [
        [{ label: "Add a task", action: "add_task" }],
        [{ label: "Back to home", action: "home" }]
      ]
    };
  }

  if (state.type === "work_briefing_target") {
    if (text.length > 1000) return response("Target too long", "Keep the SDR target under 1,000 characters.");
    await recordReviewNote(db, {
      id: `WORK-${state.runId}-target`,
      reviewType: "Work briefing",
      reviewDate: state.date,
      question: "SDR target",
      answer: text,
      relatedArea: "WORK",
      createdAt: now.toISOString()
    });
    await setConversationState(db, user.id, {
      type: "work_briefing_hypothesis",
      date: state.date,
      runId: state.runId
    }, now.toISOString());
    return planningQuestion("Work briefing — 2/3", say("preshift_2", { now }));
  }

  if (state.type === "work_briefing_hypothesis") {
    if (text.length > 1000) return response("Hypothesis too long", "Keep the hypothesis under 1,000 characters.");
    await recordReviewNote(db, {
      id: `WORK-${state.runId}-hypothesis`,
      reviewType: "Work briefing",
      reviewDate: state.date,
      question: "SDR hypothesis",
      answer: text,
      relatedArea: "WORK",
      createdAt: now.toISOString()
    });
    await setConversationState(db, user.id, {
      type: "work_briefing_learning",
      date: state.date,
      runId: state.runId
    }, now.toISOString());
    return planningQuestion("Work briefing — 3/3", say("preshift_3", { now }));
  }

  if (state.type === "work_briefing_learning") {
    if (text.length > 1000) return response("Learning question too long", "Keep the question under 1,000 characters.");
    await recordReviewNote(db, {
      id: `WORK-${state.runId}-learning`,
      reviewType: "Work briefing",
      reviewDate: state.date,
      question: "Learning question",
      answer: text,
      relatedArea: "WORK",
      createdAt: now.toISOString()
    });
    await clearConversationState(db, user.id);
    return {
      category: "Work briefing",
      title: "Work intention saved",
      sections: [{ heading: "", lines: ["Keep the target visible, test your hypothesis, and capture one useful learning."] }],
      actions: [
        [{ label: "Start 💼 Work", action: "start_outcome|WORK" }],
        [{ label: "Show full plan", action: "plan_my_day" }]
      ]
    };
  }

  if (state.type === "weekly_review") {
    const questions = getWeeklyReviewQuestions();
    const index = Number(state.index);
    const question = questions[index];
    if (!question) {
      await clearConversationState(db, user.id);
      return response("Weekly review expired", "Start the weekly review again.");
    }
    if (text.length > 1500) return response("Answer too long", "Keep each weekly review answer under 1,500 characters.");
    await recordReviewNote(db, {
      id: `WEEK-${state.runId}-${index}`,
      reviewType: "Weekly",
      reviewDate: state.date,
      question: question.text,
      answer: text,
      relatedArea: question.area,
      createdAt: now.toISOString()
    });
    if (index + 1 < questions.length) {
      state.index = index + 1;
      await setConversationState(db, user.id, state, now.toISOString(), 7200);
      return planningQuestion(`Weekly review ${state.index + 1}/${questions.length}`, questions[state.index].text);
    }
    await clearConversationState(db, user.id);
    return {
      category: "Weekly review",
      title: "Weekly reflection saved",
      sections: [{
        heading: "",
        lines: ["Your answers are saved. Use them to choose one open loop to delete, delegate, or schedule."]
      }],
      actions: [
        [{ label: "Open unfinished tasks", action: "weekly_unfinished" }],
        [{ label: "Review a project", action: "monthly_project_review" }],
        [{ label: "Back to home", action: "home" }]
      ]
    };
  }

  if (state.type === "calendar_block_start") {
    const parsed = parseCairoDateTime(text, now);
    if (!parsed) {
      return response(
        "Enter a valid Cairo start time",
        "Use 11/25/2026 2:30 PM or 2026-11-25 14:30 in Cairo time."
      );
    }
    state.type = "calendar_block_duration";
    state.date = parsed.dateKey;
    state.startTime = parsed.time;
    await setConversationState(db, user.id, state, now.toISOString());
    return {
      category: "Calendar block",
      title: "Choose a focus duration",
      sections: [{ heading: "", lines: [`${state.date} at ${state.startTime} Cairo time`] }],
      actions: [[
        { label: "25 minutes", action: `calendar_duration|${state.taskId}|25` },
        { label: "50 minutes", action: `calendar_duration|${state.taskId}|50` }
      ]]
    };
  }

  if (state.type === "monthly_project_name") {
    if (text.length > 300) return response("Project name too long", "Keep the project name under 300 characters.");
    state.type = "monthly_project_decision";
    state.project = text;
    await setConversationState(db, user.id, state, now.toISOString());
    return {
      category: "Monthly project review",
      title: text,
      sections: [{ heading: "", lines: ["Choose one project decision."] }],
      actions: [[
        { label: "Continue", action: "monthly_decision|continue" },
        { label: "Change approach", action: "monthly_decision|change" }
      ], [
        { label: "Pause", action: "monthly_decision|pause" },
        { label: "Kill", action: "monthly_decision|kill" }
      ]]
    };
  }

  if (state.type === "monthly_project_reason") {
    if (text.length > 1500) return response("Reason too long", "Keep the reason under 1,500 characters.");
    state.type = "monthly_project_review_date";
    state.reason = text;
    await setConversationState(db, user.id, state, now.toISOString());
    return {
      category: "Monthly project review",
      title: "Set a review date",
      sections: [{ heading: state.project, lines: [`${state.decision}: ${text}`] }],
      inputMode: "force_reply",
      inputPlaceholder: "11/25/2026"
    };
  }

  if (state.type === "monthly_project_review_date") {
    const reviewDate = parseDateInput(text, now);
    if (!reviewDate || reviewDate <= cairoDateKey(now)) {
      return response("Choose a future review date", "Enter a future date like 11/25/2026.");
    }
    await recordReviewNote(db, {
      id: `MONTH-${state.runId}`,
      reviewType: "Monthly project decision",
      reviewDate: state.date,
      question: `${state.decision}: ${state.project}; review date ${reviewDate}`,
      answer: state.reason,
      relatedArea: state.project,
      createdAt: now.toISOString()
    });
    await clearConversationState(db, user.id);
    return {
      category: "Monthly project review",
      title: "Project decision recorded",
      sections: [{
        heading: state.project,
        lines: [
          `Decision: ${state.decision}`,
          `Reason: ${state.reason}`,
          `Review date: ${shortDate(reviewDate)}`,
          "Add the same decision to the Trello project card. No Trello API is used."
        ]
      }],
      actions: [
        [{ label: "Review another project", action: "monthly_project_review" }],
        [{ label: "Back to home", action: "home" }]
      ]
    };
  }

  if (state.type === "outcome_drop") {
    if (text.length > 1000) {
      return response("Reason too long", "Keep the reason under 1,000 characters and try again.");
    }
    const outcome = await getDailyOutcome(db, state.date, state.area);
    if (!outcome || ["Completed", "Dropped"].includes(outcome.status)) {
      await clearConversationState(db, user.id);
      return response("Outcome no longer open", "This outcome is already closed or unavailable.");
    }
    await appendDailyOutcomeStatus(db, outcome, "Dropped", text, now);
    await clearConversationState(db, user.id);
    return {
      category: "Outcome dropped",
      title: "Outcome dropped",
      sections: [{
        heading: "",
        lines: ["Your reason is recorded. The related Google Task remains pending; no task was deleted or cancelled."]
      }],
      actions: [[{ label: "Back to home", action: "home" }]]
    };
  }

  if (state.type === "task_title") {
    if (text.length > 500) {
      return response("Task title too long", "Keep the title under 500 characters and try again.");
    }
    await setConversationState(db, user.id, {
      type: "task_area",
      title: text
    }, now.toISOString());
    return {
      category: "Task capture",
      title: "Choose an area",
      sections: [{ heading: "", lines: [text] }],
      actions: [
        [
          { label: "🌱 Growth", action: "task_area|DEEP" },
          { label: "💼 Work", action: "task_area|WORK" },
          { label: "🏠 Life", action: "task_area|LIFE" }
        ],
        [
          { label: "📎 Errands", action: "task_area|Admin" },
          { label: "⋯ Other", action: "task_area|Other" }
        ]
      ]
    };
  }

  if (state.type === "task_done_test") {
    if (text.length > 1000) {
      return response("Done test too long", "Keep the done test under 1,000 characters.");
    }
    state.doneTest = text;
    if (["DEEP", "WORK", "LIFE"].includes(state.area)) {
      state.type = "task_top3";
      await setConversationState(db, user.id, state, now.toISOString());
      return {
        category: "Task capture",
        title: "Add this to today's Top 3?",
        sections: [{ heading: "", lines: [state.title] }],
        actions: [[
          { label: "Yes, add to Top 3", action: "task_top3|yes" },
          { label: "No, just add task", action: "task_top3|no" }
        ]]
      };
    }
    return createCapturedTask({
      db, user, state, addToTop3: false, googleTasks, googleCalendar, now
    });
  }

  return response(
    "Task capture expired",
    "This conversation step is not available. Start again with /addtask."
  );
}

export async function createCapturedTask({
  db,
  user,
  state,
  addToTop3,
  googleTasks,
  googleCalendar = null,
  now,
  clearConversation = true
}) {
  if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
  if (!state.requestId) {
    state.requestId = `TASK-${crypto.randomUUID()}`;
    await setConversationState(db, user.id, state, now.toISOString());
  }
  const requestId = state.requestId;
  const existingRequest = await getTaskCreationRequest(db, requestId);
  const marker = `[assistant-request:${requestId}]`;
  let task;

  if (!existingRequest) {
    await startTaskCreationRequest(db, requestId, now.toISOString());
    const notes = [
      `Area: ${state.area}`,
      state.doneTest ? `Done looks like: ${state.doneTest}` : "",
      marker
    ].filter(Boolean).join("\n");
    try {
      task = await googleTasks.create(
        state.title,
        notes,
        state.dueDate || ""
      );
    } catch (error) {
      await updateTaskCreationRequest(
        db, requestId, null, "Needs review",
        "Task creation outcome was uncertain; check Google Tasks before retrying."
      );
      throw error;
    }
  } else {
    const allTasks = await googleTasks.listAll();
    task = existingRequest.google_task_id
      ? allTasks.find(item => item.id === existingRequest.google_task_id)
      : allTasks.find(item => String(item.notes || "").includes(marker));
    if (!task) {
      await updateTaskCreationRequest(
        db, requestId, null, "Needs review",
        "No matching Google Task was found; automatic retry is blocked to prevent duplicates."
      );
      throw new Error("Task request needs review; no duplicate task was created.");
    }
  }

  if (!task || !task.id) throw new Error("Google Tasks returned a task without an identifier.");
  const taskMirror = await upsertGoogleTaskMirror(db, task, now.toISOString(), {
    area: state.area,
    priority: state.priority || "Medium"
  });
  await updateTaskCreationRequest(db, requestId, task.id, "Created", "");
  await logSyncEvent(db, {
    source: "Google Tasks",
    operation: "Create task",
    occurredAt: now.toISOString(),
    result: "Success",
    relatedRecordId: task.id
  });
  if (addToTop3) {
    await appendDailyOutcomeFromTask(db, {
      requestId,
      date: cairoDateKey(now),
      area: state.area,
      title: state.title,
      doneTest: state.doneTest,
      taskId: task.id,
      updatedAt: now.toISOString()
    });
  }
  if (clearConversation) await clearConversationState(db, user.id);
  const sections = [{
    heading: state.title,
    lines: [
      `${state.area} · ${state.priority || "Medium"}`,
      state.dueDate ? `Due: ${state.dueDate}` : "No deadline",
      addToTop3 ? "Added to today's Top 3." : ""
    ].filter(Boolean)
  }];
  const actions = [[{ label: "Open tasks", action: "show_tasks" }]];
  if (googleCalendar && googleCalendar.createTaskBlock &&
      /^TASK-[A-Za-z0-9-]{1,48}$/.test(taskMirror.id)) {
    actions.push([{
      label: "Schedule focus time",
      action: `calendar_block|${taskMirror.id}`
    }]);
  }
  return {
    category: "Task created",
    title: "Task added",
    sections,
    actions
  };
}

async function appendDailyOutcomeFromTask(db, outcome) {
  await db.prepare(
    `INSERT INTO daily_outcomes (
       id, outcome_date, area, outcome, done_test, google_task_id,
       status, status_details, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Planned', ?7, ?8)
     ON CONFLICT(id) DO NOTHING`
  ).bind(
    `OUTCOME-${outcome.requestId}`,
    outcome.date,
    outcome.area,
    outcome.title,
    outcome.doneTest || "",
    outcome.taskId,
    outcome.statusDetails || "Created from guided task capture.",
    outcome.updatedAt
  ).run();
}

export async function createPlannedOutcomeTask({
  db,
  googleTasks,
  requestId,
  title,
  area,
  priority,
  dueDate,
  risk,
  now
}) {
  const existingRequest = await getTaskCreationRequest(db, requestId);
  const marker = `[assistant-planning-request:${requestId}]`;
  let task;
  if (!existingRequest) {
    await startTaskCreationRequest(db, requestId, now.toISOString());
    const notes = [
      `Area: ${area}`,
      "Done looks like: Define the visible result before starting.",
      `Risk: ${risk}`,
      marker
    ].join("\n");
    try {
      task = await googleTasks.create(title, notes, dueDate);
    } catch (error) {
      await updateTaskCreationRequest(
        db,
        requestId,
        null,
        "Needs review",
        "Task creation outcome was uncertain; check Google Tasks before retrying."
      );
      throw error;
    }
  } else {
    const tasks = await googleTasks.listAll();
    task = existingRequest.google_task_id
      ? tasks.find(item => item.id === existingRequest.google_task_id)
      : tasks.find(item => String(item.notes || "").includes(marker));
    if (!task) {
      await updateTaskCreationRequest(
        db,
        requestId,
        null,
        "Needs review",
        "No matching Google Task was found; automatic retry is blocked to prevent duplicates."
      );
      throw new Error("Planned task request needs review; no duplicate task was created.");
    }
  }
  if (!task || !task.id) throw new Error("Google Tasks returned a planned task without an identifier.");
  await upsertGoogleTaskMirror(db, task, now.toISOString(), { area, priority });
  await updateTaskCreationRequest(db, requestId, task.id, "Created", "");
  await logSyncEvent(db, {
    source: "Google Tasks",
    operation: "Create planned outcome task",
    occurredAt: now.toISOString(),
    result: "Success",
    relatedRecordId: task.id
  });
  return task;
}

async function recordReviewNote(db, note) {
  await db.prepare(
    `INSERT INTO review_notes (
       id, review_type, review_date, question, answer, related_area, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(id) DO NOTHING`
  ).bind(
    note.id,
    note.reviewType,
    note.reviewDate,
    note.question,
    note.answer,
    note.relatedArea || null,
    note.createdAt
  ).run();
}

async function getDailyOutcomesForDate(db, date) {
  const result = await db.prepare(
    `SELECT area, outcome, status
       FROM daily_outcomes
      WHERE outcome_date = ?1
      ORDER BY updated_at DESC, rowid DESC`
  ).bind(date).all();
  const latest = new Map();
  for (const row of result.results) {
    if (!latest.has(row.area)) latest.set(row.area, row);
  }
  return ["DEEP", "WORK", "LIFE"].map((area, index) => {
    const outcome = latest.get(area);
    return outcome
      ? `${index + 1}. ${areaLabel(area)} — ${outcome.outcome}${outcome.status !== "Planned" ? ` (${outcome.status})` : ""}`
      : null;
  }).filter(Boolean);
}

async function readCalendarEvents(db, googleCalendar, date, now) {
  if (!googleCalendar) return { enabled: false, events: null, errorDetails: null };
  try {
    return {
      enabled: true,
      events: await googleCalendar.listEventsForDate(date),
      errorDetails: null
    };
  } catch (error) {
    const errorDetails = formatGoogleErrorDetails(error);
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "WARN",
      component: "Google Calendar",
      eventType: "Calendar read failed",
      description: "Could not retrieve events for a daily plan.",
      errorMessage: errorDetails
    });
    return { enabled: true, events: null, errorDetails };
  }
}

async function beginAvailableTimeRequest({ db, user, minutes, now }) {
  if (minutes === null) {
    await setConversationState(db, user.id, {
      type: "available_time_duration"
    }, now.toISOString());
    return forceReply(
      "How much free time?",
      "Enter the number of free minutes, from 25 to 360."
    );
  }
  if (!Number.isInteger(minutes) || minutes < 25 || minutes > 360) {
    return response(
      "Free-time duration out of range",
      "Choose a whole number of minutes from 25 to 360."
    );
  }
  await setConversationState(db, user.id, {
    type: "available_time_start",
    minutes
  }, now.toISOString());
  return forceReply(
    "When does your free time start?",
    `Enter today's start time in Cairo as HH:MM. I'll check your Calendar before suggesting up to three focus sessions for ${minutes} minutes.`
  );
}

async function createAvailableTimePlan({
  db,
  user,
  minutes,
  startTime,
  googleTasks,
  googleCalendar,
  aiDailyPlanner,
  now
}) {
  const date = cairoDateKey(now);
  const [hour, minute] = startTime.split(":").map(Number);
  const startMinute = hour * 60 + minute;
  const currentParts = cairoTimeParts(now);
  const currentMinute = Number(currentParts.hour) * 60 + Number(currentParts.minute);
  const endMinute = startMinute + minutes;
  if (startMinute <= currentMinute) {
    return forceReply(
      "Choose a future start time",
      "That time has already passed in Cairo today. Enter a later HH:MM time."
    );
  }
  if (endMinute > 24 * 60) {
    return forceReply(
      "Window crosses midnight",
      "Choose an earlier start time so the free-time window ends before midnight Cairo time."
    );
  }
  if (!googleCalendar) {
    return response(
      "Calendar availability unavailable",
      "I can't verify this window because Calendar access is disabled. No schedule was created; enable Calendar access or try again later."
    );
  }

  const calendar = await readCalendarEvents(db, googleCalendar, date, now);
  if (!calendar.events) {
    return response(
      "Calendar availability unavailable",
      `I couldn't verify this window (${calendar.errorDetails}). No focus plan was created. Resolve Calendar access, then try /available again.`
    );
  }
  const startIso = Date.parse(cairoLocalDateTimeToIso(date, startTime));
  const endIso = startIso + minutes * 60_000;
  const conflicts = calendar.events.filter(event =>
    calendarEventOverlaps(event, date, startMinute, endMinute, startIso, endIso)
  );
  if (conflicts.length) {
    const conflictLines = conflicts.slice(0, 5).map(event =>
      event.allDay
        ? `All day · ${event.title}`
        : `${event.start}–${event.end} · ${event.title}`
    );
    return {
      category: "Availability conflict",
      title: "Calendar is busy during that window",
      sections: [{
        heading: "Conflicting events",
        lines: conflictLines
      }, {
        heading: "",
        lines: ["Enter another start time in Cairo. No Calendar event or task was changed."]
      }],
      inputMode: "force_reply",
      inputPlaceholder: "HH:MM"
    };
  }
  if (!googleTasks) {
    return response(
      "Google Tasks unavailable",
      "I can't build a task-based focus plan without syncing the authoritative Google Tasks list."
    );
  }

  await syncTaskList({ db, googleTasks, now });
  const candidates = await listPendingTaskPlanningCandidates(db, date);
  if (!candidates.length) {
    await clearConversationState(db, user.id);
    return response(
      "No pending tasks",
      "There are no pending Google Tasks to include. Your Calendar and task list were not changed."
    );
  }

  const goalFocus = await listDailyGoalFocus(db, user.id, date, 3);
  const planningCandidates = candidates.slice(0, 12);
  const rankedIds = [];
  let aiUsed = false;
  let aiUnavailable = false;
  if (aiDailyPlanner) {
    try {
      const taskIds = await aiDailyPlanner({
        date,
        tasks: planningCandidates,
        goals: goalFocus
      });
      if (taskIds === null) {
        aiUnavailable = true;
      } else if (!Array.isArray(taskIds)) {
        throw new TypeError("AI daily prioritizer returned an invalid result.");
      } else {
        const allowedIds = new Set(planningCandidates.map(task => task.id));
        rankedIds.push(...[...new Set(taskIds.filter(id => allowedIds.has(id)))].slice(0, 3));
        aiUsed = rankedIds.length > 0;
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "ai_availability_prioritization_failed",
        errorType: error && error.name || "Error"
      }));
      aiUnavailable = true;
    }
  }
  for (const task of candidates) {
    if (rankedIds.length >= 3) break;
    if (!rankedIds.includes(task.id)) rankedIds.push(task.id);
  }
  const tasksById = new Map(candidates.map(task => [task.id, task]));
  const tasks = rankedIds.map(id => tasksById.get(id)).filter(Boolean);
  const schedule = buildAvailableTimeSchedule(startMinute, minutes, tasks);
  await clearConversationState(db, user.id);

  const sections = [{
    heading: `Suggested focus plan · ${date}`,
    lines: schedule.blocks.map(block =>
      `${formatMinuteOfDay(block.start)}–${formatMinuteOfDay(block.end)} · ${block.title} (${block.minutes} min)`
    )
  }];
  const breaks = schedule.breaks.map(block =>
    `${formatMinuteOfDay(block.start)}–${formatMinuteOfDay(block.end)} · Break`
  );
  if (breaks.length) sections.push({ heading: "Breaks", lines: breaks });
  if (schedule.unallocatedMinutes > 0) {
    sections.push({
      heading: "Unallocated buffer",
      lines: [`${schedule.unallocatedMinutes} minutes left unscheduled; no duration was inferred for any task.`]
    });
  }
  sections.push({
    heading: "How this was built",
    lines: [
      aiUsed
        ? "Workers AI ranked the pending Google Tasks; the remaining order uses due dates and task priority."
        : aiUnavailable
          ? "Workers AI was unavailable or at its usage limit; tasks are ordered deterministically by due date and priority."
          : "Tasks are ordered deterministically by due date and priority.",
      "Calendar was checked for conflicts. This is advisory only: no Calendar events were created and no task status or due date changed."
    ]
  });
  return {
    category: "Availability planning",
    title: "Your free-time focus plan",
    sections,
    actions: [[{ label: "Back to daily plan", action: "home" }]]
  };
}

function calendarEventOverlaps(event, date, startMinute, endMinute, startIso, endIso) {
  if (event.allDay) return true;
  const eventStart = Date.parse(event.startTime || "");
  const eventEnd = Date.parse(event.endTime || "");
  if (Number.isFinite(eventStart) && Number.isFinite(eventEnd)) {
    return eventStart < endIso && eventEnd > startIso;
  }
  if (!/^\d{2}:\d{2}$/.test(String(event.start || "")) ||
      !/^\d{2}:\d{2}$/.test(String(event.end || ""))) {
    return false;
  }
  const [startHour, startMinutePart] = event.start.split(":").map(Number);
  const [endHour, endMinutePart] = event.end.split(":").map(Number);
  const eventStartMinute = startHour * 60 + startMinutePart;
  let eventEndMinute = endHour * 60 + endMinutePart;
  if (eventEndMinute <= eventStartMinute) eventEndMinute += 24 * 60;
  const extendsFromPreviousDay = event.startTime &&
    !Number.isNaN(Date.parse(event.startTime)) &&
    cairoDateKey(new Date(event.startTime)) < date;
  const effectiveStart = extendsFromPreviousDay ? eventStartMinute - 24 * 60 : eventStartMinute;
  return effectiveStart < endMinute && eventEndMinute > startMinute;
}

function buildAvailableTimeSchedule(startMinute, totalMinutes, tasks) {
  const blocks = [];
  const breaks = [];
  let cursor = startMinute;
  let remaining = totalMinutes;
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    if (remaining < 25) break;
    const workMinutes = remaining >= 50 ? 50 : remaining >= 25 ? 25 : remaining;
    blocks.push({
      start: cursor,
      end: cursor + workMinutes,
      minutes: workMinutes,
      title: task.title
    });
    cursor += workMinutes;
    remaining -= workMinutes;
    if (workMinutes === 50 && index < tasks.length - 1 && remaining >= 35) {
      breaks.push({ start: cursor, end: cursor + 10 });
      cursor += 10;
      remaining -= 10;
    }
  }
  return {
    blocks,
    breaks,
    unallocatedMinutes: remaining
  };
}

function formatMinuteOfDay(value) {
  const hour = String(Math.floor(value / 60)).padStart(2, "0");
  const minute = String(value % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

export async function showCalmHome({ db, user, googleTasks, googleCalendar, aiDailyPlanner, now }) {
  const date = cairoDateKey(now);
  if (googleTasks) await syncTaskList({ db, googleTasks, now });
  const name = await getDisplayName(db);
  const greeting = greetingLine(name, now);
  const dateLabel = shortDate(date);
  const active = await db.prepare(
    `SELECT id, next_action, due_at
       FROM focus_sessions
      WHERE user_id = ?1 AND followup_status = 'Scheduled'
        AND due_at > ?2
      ORDER BY due_at DESC LIMIT 1`
  ).bind(user.id, now.toISOString()).first();
  const nowLine = active
    ? `⏳ Now · ${active.next_action || "Focus block"} · ends ${timeLabel(active.due_at)}`
    : "⏳ Now · Nothing running. Ready for the next one?";
  const pending = await listPendingTaskPlanningCandidates(db, date);
  const nextTask = pending.find(task => task.status === "Pending");
  const nextLine = nextTask ? `⏭ Next · ${nextTask.title}` : "⏭ Next · Nothing pending";
  const why = nextTask
    ? `<i>Why: ${nextTask.due_date <= date ? "due today" : nextTask.priority === "High" ? "High priority" : "linked to a goal"}</i>`
    : "<i>Why: your list is clear</i>";
  const outcomes = await db.prepare(
    `SELECT area, status FROM daily_outcomes
      WHERE outcome_date = ?1
      ORDER BY updated_at DESC, rowid DESC`
  ).bind(date).all();
  const completed = new Set(outcomes.results.filter(row => row.status === "Completed").map(row => row.area)).size;
  const progress = `${"▰".repeat(completed)}${"▱".repeat(Math.max(0, 3 - completed))} ${completed} of 3 outcomes done`;
  const dueToday = pending.filter(task => task.due_date === date).length;
  const sections = [
    { heading: "", lines: [`${greeting} · ${dateLabel}`, nowLine, nextLine, why, progress] }
  ];
  if (dueToday >= 4) sections.push({ heading: "", lines: [`Heads-up: ${dueToday} tasks are due today. That's a lot. Pick the 1–3 that matter most.`] });
  return {
    category: "HQ",
    title: "",
    sections,
    actions: [[
      { label: "▶️ Go", action: nextTask ? `start_task|${nextTask.id}` : "focus_now" },
      { label: "🧭 Where I'm at", action: "wya" },
      { label: "More", action: "home_more" }
    ]]
  };
}

export async function showFullPlan({ db, user, googleTasks, googleCalendar, now }) {
  const date = cairoDateKey(now);
  if (googleTasks) await syncTaskList({ db, googleTasks, now });
  const pending = await listPendingTaskPlanningCandidates(db, date);
  const overdue = pending.filter(task => task.due_date && task.due_date < date).slice(0, 3);
  const dueToday = pending.filter(task => task.due_date === date).slice(0, 3);
  const sections = [];
  if (overdue.length) sections.push({
    heading: "🔴 Overdue",
    lines: overdue.map(task => `🔴 ${task.title}${task.priority === "High" ? " 🔥" : task.priority === "Low" ? " 🧊" : ""}`)
  });
  if (dueToday.length) sections.push({
    heading: "🟡 Due today",
    lines: dueToday.map(task => `🟡 ${task.title}${task.priority === "High" ? " 🔥" : task.priority === "Low" ? " 🧊" : ""}`)
  });
  if (googleCalendar) {
    try {
      const events = await googleCalendar.listEventsForDate(date);
      const upcoming = events.filter(event => !event.allDay).slice(0, 3);
      if (upcoming.length) sections.push({
        heading: "📅 Calendar",
        lines: upcoming.map(event => `📅 ${event.start} – ${event.end} · ${event.title}`)
      });
    } catch {}
  }
  const goals = await listGoals(db, user.id);
  if (goals.length) sections.push({
    heading: "🎯 Goals",
    lines: goals.slice(0, 3).map(goal => `${goal.title}`)
  });
  return {
    category: "Full plan",
    title: "",
    sections: sections.length ? sections : [{ heading: "", lines: ["You're clear for today."] }],
    actions: [[{ label: "⬅ Back", action: "home_back" }]]
  };
}

export async function showWhereIAm({ db, user, now }) {
  const date = cairoDateKey(now);
  const session = await db.prepare(
    `SELECT next_action, started_at
       FROM focus_sessions
      WHERE user_id = ?1
      ORDER BY started_at DESC LIMIT 1`
  ).bind(user.id).first();
  const completed = await db.prepare(
    `SELECT outcome FROM daily_outcomes
      WHERE outcome_date = ?1 AND status = 'Completed'
      ORDER BY updated_at DESC LIMIT 3`
  ).bind(date).all();
  const active = await db.prepare(
    `SELECT outcome, area FROM daily_outcomes
      WHERE outcome_date = ?1 AND status NOT IN ('Completed','Dropped')
      ORDER BY updated_at DESC LIMIT 1`
  ).bind(date).first();
  const lines = [];
  if (session) lines.push(`Doing: ${session.next_action || "Focus session"} since ${timeLabel(session.started_at)}`);
  else lines.push("Doing: nothing running");
  if (completed.results.length) {
    lines.push(...completed.results.map(row => `✅ ${row.outcome}`));
  }
  if (active) lines.push(`Next: ${active.outcome}`);
  else lines.push("Next: nothing pending");
  return {
    category: "Where I'm at",
    title: "",
    sections: [{ heading: "", lines }],
    actions: [[{ label: "▶️ Go", action: "focus_now" }]]
  };
}

export function formatTaskStack(tasks) {
  return tasks.slice(0, 8).map(task => {
    const status = task.status === "Completed" ? "✅" : task.due_date && task.due_date < "9999-99-99" ? "🟢" : "⚪";
    const priority = task.priority === "High" ? " 🔥" : task.priority === "Low" ? " 🧊" : "";
    const due = task.due_date ? ` · due ${shortDate(task.due_date)}` : "";
    return `${status} ${task.title}${priority}${due}`;
  });
}

export async function showTaskStack({ db, googleTasks, now }) {
  if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
  await syncTaskList({ db, googleTasks, now });
  const tasks = await listPendingTaskMirrors(db, cairoDateKey(now), 8, 0);
  const completionRows = tasks.slice(0, 3).map(task => ({
    label: `✅ Done · ${task.title.slice(0, 22)}`,
    action: `task_complete|${task.id}`
  }));
  const actions = completionRows.length
    ? [completionRows, [{ label: "More", action: "show_tasks" }]]
    : [[{ label: "More", action: "show_tasks" }]];
  return {
    category: "Task stack",
    title: "",
    sections: [{ heading: "", lines: formatTaskStack(tasks) }],
    actions
  };
}

export function showPipelineOverview() {
  return {
    category: "Pipeline",
    title: "",
    sections: [{
      heading: "",
      lines: [
        "I'm your private helper in Telegram.",
        "I keep your day clear, check on you, and remember things for you.",
        "Tasks live in Google Tasks; I keep a copy.",
        "Reminders, plans, notes and reviews live in my database.",
        "Calendar is read from Google Calendar.",
        "Unread mail is read, never changed.",
        "Plan the day → do one thing at a time → I check on you → we wrap up at night."
      ]
    }],
    actions: [[
      { label: "🕒 Daily rhythm", action: "pipeline_rhythm" },
      { label: "🛡 My rules", action: "pipeline_rules" },
      { label: "⚙️ Settings now", action: "pipeline_settings" }
    ]]
  };
}

async function showHome({ db, user, googleTasks, googleCalendar, aiDailyPlanner, now }) {
  const date = cairoDateKey(now);
  if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
  await syncTaskList({ db, googleTasks, now });
  const outcomes = await db.prepare(
    `SELECT area, outcome, status
       FROM daily_outcomes
      WHERE outcome_date = ?1
    ORDER BY updated_at DESC, rowid DESC`
  ).bind(date).all();
  const latest = new Map();
  for (const row of outcomes.results) {
    if (!latest.has(row.area)) latest.set(row.area, row);
  }
  const outcomeLines = ["DEEP", "WORK", "LIFE"].map((area, index) => {
    const outcome = latest.get(area);
    return outcome ? `${index + 1}. ${areaLabel(area)} — ${outcome.outcome}` : null;
  }).filter(Boolean);
  const taskCandidates = await listPendingTaskPlanningCandidates(db, date);
  const taskPlan = buildDailyTaskPlan(taskCandidates, date);
  const goalFocus = await listDailyGoalFocus(db, user.id, date);
  const calendar = await readCalendarEvents(db, googleCalendar, date, now);
  const sections = [{
    heading: "Your three outcomes",
    lines: outcomeLines
  }, ...formatDailyTaskPlan(taskPlan, date)];
  sections.push({
    heading: "Goal-aligned next actions",
    lines: goalFocus.length
      ? formatGoalFocus(goalFocus, date)
      : ["No objectives defined yet. Use /goal to define one when ready."]
  });
  if (calendar.enabled) {
    sections.push({
      heading: "Today's calendar",
      lines: calendar.events
        ? calendar.events.length
          ? calendar.events.map(formatCalendarEvent)
          : ["No appointments today."]
        : [
            `Calendar unavailable (${calendar.errorDetails}).`,
            formatCalendarFailureGuidance(calendar.errorDetails),
            "Your synchronized task plan is still available."
          ]
    });
  }
  sections.push({ heading: "", lines: ["What do you want to move forward now?"] });

  const actions = [
    [
      { label: "🌱 Growth", action: "start_outcome|DEEP" },
      { label: "💼 Work", action: "start_outcome|WORK" }
    ],
    [{ label: "🏠 Life", action: "start_outcome|LIFE" }],
    [
      { label: "Add something", action: "add_task" },
      { label: "Show full plan", action: "show_tasks" }
    ]
  ];
  if (aiDailyPlanner) {
    actions.push([{ label: "AI focus suggestion", action: `ai_daily_plan|${date}` }]);
  }
  actions.push([{ label: "Review goals", action: "goals_show" }]);
  return {
    category: "Daily home",
    title: "Good morning.",
    sections,
    actions
  };
}

async function showAiDailyPrioritySuggestion({
  db,
  user,
  googleTasks,
  aiDailyPlanner,
  date,
  now
}) {
  if (date !== cairoDateKey(now)) {
    return response("Suggestion expired", "Open today's plan to request a current recommendation.");
  }
  if (!aiDailyPlanner) {
    return response("AI planning disabled", "The deterministic daily plan remains available; no AI request was made.");
  }
  if (!googleTasks) {
    return response("Google Tasks unavailable", "A current task sync is required; no recommendation was made.");
  }
  await syncTaskList({ db, googleTasks, now });
  const existing = await getDailyFocusRecommendation(db, user.id, date);
  if (existing) return formatStoredAiDailyRecommendation(existing, date);
  const candidates = (await listPendingTaskPlanningCandidates(db, date)).slice(0, 12);
  if (!candidates.length) {
    return response("No open tasks", "There are no pending Google Tasks to prioritize.");
  }
  const goals = await listDailyGoalFocus(db, user.id, date, 3);

  let taskIds;
  try {
    taskIds = await aiDailyPlanner({ date, tasks: candidates, goals });
  } catch (error) {
    console.error(JSON.stringify({
      event: "ai_daily_prioritization_failed",
      errorType: error && error.name || "Error"
    }));
    return response(
      "AI suggestion unavailable",
      "I couldn't safely produce a recommendation. Your deterministic plan and Google Tasks are unchanged."
    );
  }
  if (taskIds === null) {
    return response(
      "AI suggestion unavailable",
      "The AI usage or input limit was reached. Your deterministic plan and Google Tasks are unchanged."
    );
  }
  if (!Array.isArray(taskIds)) {
    throw new TypeError("AI daily prioritizer returned an invalid result.");
  }
  const tasksById = new Map(candidates.map(task => [task.id, task]));
  const safeTaskIds = [...new Set(taskIds)]
    .filter(id => tasksById.has(id))
    .slice(0, 3);
  const saved = await saveDailyFocusRecommendation(
    db,
    user.id,
    date,
    safeTaskIds,
    now.toISOString()
  );
  return formatStoredAiDailyRecommendation(saved, date);
}

function formatStoredAiDailyRecommendation(recommendation, date) {
  const selectedTasks = recommendation.tasks;
  const decision = recommendation.decision === "Pending"
    ? "No response recorded yet."
    : `Your response: ${recommendation.decision.toLowerCase()}.`;
  return {
    category: "AI daily recommendation",
    title: "Suggested focus",
    sections: [{
      heading: "Review before acting",
      lines: selectedTasks.length
        ? selectedTasks.map((task, index) =>
          `${index + 1}. ${task.title}\n${task.status === "Pending"
            ? `Signal: ${formatTaskPriorityEvidence(task, date)}`
            : `Current Google Tasks status: ${task.status}`}`
        )
        : ["No task was selected. Use the deterministic plan to choose your next action."]
    }, {
      heading: "",
      lines: [
        "This is a suggestion based on up to 12 pending tasks and active goals. No task was changed.",
        decision
      ]
    }],
    actions: [
      ...(recommendation.taskIds.length
        ? [[
            { label: "Accept suggestion", action: `ai_recommendation|${recommendation.id}|accepted` },
            { label: "Not now", action: `ai_recommendation|${recommendation.id}|rejected` }
          ]]
        : []),
      [{ label: "Back to daily plan", action: "home" }]
    ]
  };
}

function formatTaskPriorityEvidence(task, date) {
  const evidence = [];
  if (task.due_date && task.due_date <= date) {
    evidence.push(task.due_date < date ? "overdue" : "due today");
  }
  if (task.priority === "High") evidence.push("high priority");
  if (Number(task.linked_goal_count) > 0) evidence.push("supports an active goal");
  const postponements = Number(task.postponement_count || 0);
  if (postponements >= 3) evidence.push(`postponed ${postponements} times`);
  return evidence.length ? evidence.join(", ") : "selected from pending tasks; confirm it fits";
}

async function showPlanForDate({ db, user, googleTasks, googleCalendar, date, title, now }) {
  if (!isValidDateKey(date)) throw new TypeError("Requested plan date is invalid.");
  if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
  await syncTaskList({ db, googleTasks, now });
  const outcomes = await getDailyOutcomesForDate(db, date);
  const taskCandidates = await listPendingTaskPlanningCandidates(db, date);
  const taskPlan = buildDailyTaskPlan(taskCandidates, date);
  const goalFocus = await listDailyGoalFocus(db, user.id, date);
  const calendar = await readCalendarEvents(db, googleCalendar, date, now);
  return {
    category: "Daily plan",
    title,
    sections: [
      { heading: "🌱 Growth · 💼 Work · 🏠 Life", lines: outcomes },
      ...formatDailyTaskPlan(taskPlan, date, cairoDateKey(now)),
      {
        heading: "Goal-aligned next actions",
        lines: goalFocus.length
          ? formatGoalFocus(goalFocus, date)
          : ["No objectives defined yet. Use /goal to define one when ready."]
      },
      {
        heading: "Calendar",
        lines: !calendar.enabled
          ? ["Calendar integration is disabled until OAuth access is authorized."]
          : calendar.events
            ? calendar.events.length
              ? calendar.events.map(formatCalendarEvent)
              : ["No appointments on this date."]
            : [
                `Calendar unavailable (${calendar.errorDetails}).`,
                formatCalendarFailureGuidance(calendar.errorDetails),
                "The task plan is still available."
              ]
      }
    ],
    actions: [
      [{ label: "Plan tomorrow", action: "plan_next_day_now" }],
      [{ label: "Back to home", action: "home" }]
    ]
  };
}

function formatGoalFocus(goals, date) {
  return goals.map(goal => {
    const deadline = goal.deadline
      ? ` · deadline ${goal.deadline}${goal.deadline < date ? " (passed)" : ""}`
      : "";
    const progress = goal.progress_fraction == null
      ? ""
      : ` · measured ${Math.round(goal.progress_fraction * 100)}%`;
    const linkedTask = goal.linked_task_title
      ? ` · linked task: ${goal.linked_task_title}`
      : "";
    return `${formatGoalLevel(goal.level)}: ${goal.title}${deadline}${progress}\nNext: ${goal.next_action}${linkedTask}`;
  });
}

function formatCalendarEvent(event) {
  if (event.allDay) return `All day · ${event.title}`;
  return `${event.start}–${event.end} · ${event.title}`;
}

async function showTasks({ db, googleTasks, now }) {
  const today = cairoDateKey(now);
  if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
  await syncTaskList({ db, googleTasks, now });
  const tasks = await listPendingTaskMirrors(db, today, 8, 0);
  if (!tasks.length) {
    return {
      category: "Task list",
      title: "Your open tasks",
      sections: [{ heading: "", lines: ["There are no pending tasks in the synchronized task list."] }],
      actions: [[{ label: "Back to home", action: "home" }]]
    };
  }

  const groups = [
    { title: "OVERDUE", predicate: task => task.due_date && task.due_date < today },
    { title: "DUE TODAY", predicate: task => task.due_date === today },
    { title: "UPCOMING", predicate: task => task.due_date && task.due_date > today },
    { title: "NO DEADLINE", predicate: task => !task.due_date }
  ];
  const sections = [];
  for (const group of groups) {
    const rows = tasks.filter(group.predicate);
    if (rows.length) {
      sections.push({
        heading: group.title,
        lines: rows.map(task => `${task.title} — ${task.priority || "Medium"}`)
      });
    }
  }
  const actions = tasks.filter(task => task.google_task_id).slice(0, 5).map(task => ([{
    label: `Done · ${task.title.slice(0, 30)}`,
    action: `task_complete|${task.google_task_id}`
  }]));
  actions.push([{ label: "Back to home", action: "home" }]);
  return {
    category: "Task list",
    title: "Your open tasks",
    sections: [
      { heading: "", lines: [`Showing up to ${tasks.length} pending tasks`] },
      ...sections
    ],
    actions
  };
}

async function showOverdueTasks({ db, googleTasks, now }) {
  const today = cairoDateKey(now);
  if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
  await syncTaskList({ db, googleTasks, now });
  const tasks = await listOverdueTaskMirrors(db, today, 20);
  if (!tasks.length) {
    return {
      category: "Overdue tasks",
      title: "No overdue tasks",
      sections: [{
        heading: "",
        lines: ["Google Tasks currently has no pending tasks past their due date."]
      }],
      actions: [[{ label: "Back to home", action: "home" }]]
    };
  }
  const actions = tasks.filter(task => task.google_task_id).slice(0, 5).map(task => ([{
    label: `Done · ${task.title.slice(0, 30)}`,
    action: `task_complete|${task.google_task_id}`
  }]));
  actions.push([{ label: "Show open tasks", action: "show_tasks" }]);
  return {
    category: "Overdue tasks",
    title: "Pending past their due date",
    sections: [{
      heading: `Showing up to ${tasks.length} overdue tasks`,
      lines: tasks.map(task =>
        `${task.title} · due ${task.due_date} · ${task.priority || "Medium"} priority`
      )
    }],
    actions
  };
}

async function showInboxTriage({
  db,
  googleGmail,
  emailFollowUpAnalyzer,
  now
}) {
  if (!googleGmail) {
    return {
      category: "Gmail inbox",
      title: "Read-only inbox access is disabled",
      sections: [{
        heading: "",
        lines: ["This view requires the Gmail read-only OAuth scope and GOOGLE_GMAIL_READ_ENABLED. Sending scheduled reports is a separate permission."]
      }],
      actions: []
    };
  }

  let threads;
  try {
    threads = await googleGmail.listUnreadInboxThreads(5);
  } catch (error) {
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "WARN",
      component: "Gmail triage",
      eventType: "Inbox read failed",
      description: "Could not retrieve Gmail inbox metadata.",
      errorMessage: formatGoogleErrorDetails(error)
    });
    const failureMessage = error && error.oauthErrorCode === "invalid_grant"
      ? "Google rejected the saved refresh grant. Reauthorize Google and update the existing OAuth secret directly in Cloudflare; do not send credentials here."
      : error && error.oauthErrorCode === "invalid_client"
        ? "Google rejected the OAuth client credentials. Correct the existing client credentials in Cloudflare; do not send them here."
        : error && Number(error.status) === 403
          ? "Google denied Gmail read access. Confirm the Gmail read-only scope and API access."
          : "Confirm that the configured Google OAuth connection can read Gmail metadata.";
    return {
      category: "Gmail inbox",
      title: "Gmail inbox access unavailable",
      sections: [{
        heading: "",
        lines: [
          `I couldn't read inbox metadata (${formatGoogleErrorDetails(error)}).`,
          failureMessage,
          "No messages were marked read or sent."
        ]
      }],
      actions: []
    };
  }

  if (!threads.length) {
    return {
      category: "Gmail inbox",
      title: "No unread conversations to review",
      sections: [{
        heading: "",
        lines: ["No unread inbound Gmail messages were found. No messages were changed."]
      }],
      actions: []
    };
  }

  let followUps = null;
  let analysisMessage = "";
  if (emailFollowUpAnalyzer && typeof googleGmail.readMessageText === "function") {
    try {
      const analyzedThreads = await Promise.all(threads.map(async thread => ({
        ...thread,
        bodyText: await googleGmail.readMessageText(thread.messageId)
      })));
      followUps = await emailFollowUpAnalyzer(analyzedThreads);
      if (!followUps) {
        analysisMessage = "Workers AI couldn't analyze these messages (no readable plain text, temporary service issue, or daily free-usage limit). No messages were changed.";
      }
    } catch (error) {
      await logSystemEvent(db, {
        occurredAt: now.toISOString(),
        severity: "WARN",
        component: "Gmail triage",
        eventType: "Email follow-up analysis failed",
        description: "Could not safely analyze unread Gmail message text.",
        errorMessage: formatGoogleErrorDetails(error)
      });
      analysisMessage = "I couldn't safely analyze message contents. No messages were changed.";
    }
  } else {
    analysisMessage = "Workers AI email analysis is disabled or unavailable. No messages were changed.";
  }

  const verifiedFollowUps = Array.isArray(followUps)
    ? followUps.filter(item =>
        item &&
        /^[A-Za-z0-9_-]{1,32}$/.test(item.threadId) &&
        threads.some(thread => thread.threadId === item.threadId)
      )
    : [];
  const actionLabels = {
    reply: "A reply may be needed",
    prepare: "Preparation may be needed",
    review: "Review may be needed",
    provide_information: "Requested information may be needed",
    confirm: "A decision or confirmation may be needed",
    other: "A follow-up may be needed"
  };
  const threadById = new Map(threads.map(thread => [thread.threadId, thread]));
  const actions = verifiedFollowUps.flatMap(item => [[
    { label: "Create follow-up task", action: `gmail_followup_task|${item.threadId}` },
    { label: "Not now", action: `gmail_followup_dismiss|${item.threadId}` }
  ]]);
  const followUpLines = verifiedFollowUps.map(item => {
    const thread = threadById.get(item.threadId);
    return [
      `${truncate(thread.subject, 140)} · ${actionLabels[item.actionType] || "A follow-up may be needed"}`,
      `Evidence: “${truncate(item.evidenceQuote, 160)}”`,
      item.deadlineEvidence
        ? `Deadline wording: “${truncate(item.deadlineEvidence, 100)}”`
        : ""
    ].filter(Boolean).join("\n");
  });
  const sections = [
    {
      heading: "Unread inbound messages",
      lines: threads.map(thread =>
        `From: ${thread.from}\nSubject: ${truncate(thread.subject, 180)}\nReceived: ${formatCairoDateTime(thread.receivedAt)}`
      )
    }
  ];
  if (verifiedFollowUps.length) {
    sections.push({
      heading: "Workers AI potential follow-ups (evidence checked against the message)",
      lines: followUpLines
    });
  } else if (followUps && followUps.length === 0) {
    sections.push({
      heading: "Workers AI review",
      lines: ["No verifiable action request was found in the analyzed text. Review the messages yourself; this is not proof that no action is needed."]
    });
  }
  sections.push({
    heading: "",
    lines: [
      "No messages were marked read or sent.",
      analysisMessage,
      verifiedFollowUps.length
        ? "Workers AI suggestions are advisory. A task is added to Google Tasks only after you tap its button; no email is sent."
        : ""
    ].filter(Boolean)
  });
  return {
    category: "Gmail inbox",
    title: "Unread email conversations",
    sections,
    actions
  };
}

async function showManualAccountabilityCheckin({ db, now }) {
  const date = cairoDateKey(now);
  const checkins = await listManualAccountabilityCheckins(db, date);
  return {
    category: "Manual accountability",
    title: "Trello and Obsidian check-in",
    sections: [{
      heading: date,
      lines: checkins.map(checkin => {
        const label = checkin.routine_id === "ROUTINE-TRELLO" ? "Trello" : "Obsidian";
        const status = checkin.status === "Completed"
          ? "Done today"
          : checkin.status === "Missed" ? "Not done today" : "Not recorded today";
        return `${label}: ${status}`;
      })
    }, {
      heading: "",
      lines: ["This is a manual check-in. The assistant does not access Trello or Obsidian."]
    }],
    actions: checkins.map(checkin => {
      const label = checkin.routine_id === "ROUTINE-TRELLO" ? "Trello" : "Obsidian";
      return [
        { label: `${label}: Done`, action: `accountability_done|${checkin.routine_id}` },
        { label: `${label}: Not done`, action: `accountability_missed|${checkin.routine_id}` }
      ];
    })
  };
}

async function beginFocusNow({ db, user, now }) {
  const date = cairoDateKey(now);
  const result = await db.prepare(
    `SELECT id, outcome_date, area, outcome, done_test, google_task_id, status,
            status_details, calendar_event_id, block_start, block_end
       FROM daily_outcomes
      WHERE outcome_date = ?1
      ORDER BY updated_at DESC, rowid DESC`
  ).bind(date).all();
  const latest = new Map();
  for (const row of result.results) {
    if (!latest.has(row.area)) latest.set(row.area, row);
  }
  const outcome = ["DEEP", "WORK", "LIFE"]
    .map(area => latest.get(area))
    .find(row => row && !["Completed", "Dropped"].includes(row.status));
  if (!outcome) {
    return {
      category: "Focus now",
      title: "No outcome is set for today",
      sections: [{ heading: "", lines: ["Add a next action and choose Growth, Work, Life, Errands, or Other."] }],
      actions: [[{ label: "Add something", action: "add_task" }]]
    };
  }
  return beginOutcomeSprint({ db, user, outcome, now });
}

async function beginOutcomeSprint({ db, user, outcome, now }) {
  await setConversationState(db, user.id, {
    type: "focus_action",
    date: outcome.outcome_date,
    area: outcome.area
  }, now.toISOString());
  return {
    category: "Focus prompt",
    title: "Focus started",
    sections: [{
      heading: `${outcome.area} outcome`,
      lines: [
        outcome.outcome,
        "What is the smallest visible result you can finish in the next 25–50 minutes?"
      ]
    }],
    inputMode: "force_reply",
    inputPlaceholder: "Name one visible next action"
  };
}

async function createOutcomeAndBeginSprint({ db, user, state, text, googleTasks, now }) {
  const date = state.date || cairoDateKey(now);
  if (!isValidDateKey(date) || !["DEEP", "WORK", "LIFE"].includes(state.area)) {
    throw new Error("Daily outcome conversation state is invalid.");
  }
  const result = await createCapturedTask({
    db,
    user,
    state: {
      date,
      title: text,
      area: state.area,
      priority: state.area === "LIFE" ? "Medium" : "High",
      dueDate: date,
      doneTest: `Complete the stated outcome: ${text}`,
      type: "outcome_define",
      requestId: state.requestId
    },
    addToTop3: true,
    googleTasks,
    now
  });
  const outcome = await getDailyOutcome(db, date, state.area);
  if (!outcome) throw new Error("The new daily outcome was not recorded.");
  const prompt = await beginOutcomeSprint({ db, user, outcome, now });
  return {
    ...prompt,
    sections: [{
      heading: "Outcome saved as a Google Task",
      lines: [text, "What is the smallest visible result you can finish in the next 25–50 minutes?"]
    }],
    category: result.category
  };
}

async function getDailyOutcome(db, date, area) {
  return db.prepare(
    `SELECT id, outcome_date, area, outcome, done_test, google_task_id, status,
            status_details, calendar_event_id, block_start, block_end
       FROM daily_outcomes
      WHERE outcome_date = ?1 AND area = ?2
      ORDER BY updated_at DESC, rowid DESC
      LIMIT 1`
  ).bind(date, area).first();
}

async function appendDailyOutcomeStatus(db, outcome, status, details, now) {
  return appendFocusOutcomeStatus(db, outcome, status, details, now.toISOString());
}

async function appendOutcomeIfChanged(db, outcome, status, details, now) {
  if (outcome.status === status && outcome.status_details === details) return;
  await appendDailyOutcomeStatus(db, outcome, status, details, now);
}

function parseTypedShortcut(text) {
  const match = String(text || "").trim().toLowerCase().match(/^(growth|deep|work|life)(?:\s+(25|50))?$/);
  if (!match) return null;
  const area = match[1] === "growth" || match[1] === "deep"
    ? "DEEP"
    : match[1] === "work"
      ? "WORK"
      : "LIFE";
  return { area, duration: match[2] ? Number(match[2]) : null };
}

async function beginShortcutFocus({ db, user, area, duration, googleTasks, now }) {
  if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
  await syncTaskList({ db, googleTasks, now });
  const date = cairoDateKey(now);
  const outcome = await getDailyOutcome(db, date, area);
  if (!outcome) {
    await setConversationState(db, user.id, {
      type: "outcome_define",
      date,
      area
    }, now.toISOString());
    return {
      category: "Daily outcome",
      title: `Set your ${areaLabel(area)} outcome`,
      sections: [{ heading: "", lines: ["What does done look like, and when will you do it?"] }],
      inputMode: "force_reply",
      inputPlaceholder: "Describe one outcome"
    };
  }
  if (duration) {
    await setConversationState(db, user.id, {
      type: "focus_duration",
      date,
      area,
      nextAction: outcome.done_test || outcome.outcome,
      googleTaskId: outcome.google_task_id
    }, now.toISOString());
    return handleShortcutDurationAction({ db, user, outcome, duration, now });
  }
  return beginOutcomeSprint({ db, user, outcome, now });
}

async function handleShortcutDurationAction({ db, user, outcome, duration, now }) {
  const dueAt = new Date(now.getTime() + duration * 60_000);
  await recordFocusSession(db, {
    id: `FOCUS-${crypto.randomUUID()}`,
    userId: user.id,
    chatId: String(user.external_user_id),
    date: cairoDateKey(now),
    area: outcome.area,
    googleTaskId: outcome.google_task_id,
    nextAction: outcome.done_test || outcome.outcome,
    durationMinutes: duration,
    startedAt: now.toISOString(),
    dueAt: dueAt.toISOString()
  });
  await clearConversationState(db, user.id);
  return response(
    "Focus block",
    `${duration}-minute ${areaLabel(outcome.area)} focus block started. Follow-up: ${timeLabel(dueAt)} Cairo time.`
  );
}

function parseQuickCapture(text, now) {
  const match = String(text || "").trim().match(/^add\s+(.+)$/i);
  if (!match) return null;
  let rest = match[1].trim();
  const priorityMatch = rest.match(/\s+(high|medium|low)$/i);
  const priority = priorityMatch ? titleCase(priorityMatch[1]) : "Medium";
  if (priorityMatch) rest = rest.slice(0, priorityMatch.index).trim();
  let dueDate = "";
  const relative = rest.match(/\s+(today|tomorrow)$/i);
  if (relative) {
    dueDate = parseDateInput(relative[1], now) || "";
    rest = rest.slice(0, relative.index).trim();
  } else {
    const namedDate = rest.match(/\s+(11\/25(?:\/2026)?|[A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?|2026-\d{2}-\d{2})$/);
    if (namedDate) {
      dueDate = parseDateInput(namedDate[1], now) || "";
      if (dueDate) rest = rest.slice(0, namedDate.index).trim();
    }
  }
  if (!rest) return null;
  return {
    title: rest.slice(0, 500),
    area: "WORK",
    priority,
    dueDate
  };
}

async function createQuickCapturedTask({ db, user, googleTasks, capture, now }) {
  if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
  return createCapturedTask({
    db,
    user,
    state: {
      requestId: `TASK-QUICK-${crypto.randomUUID()}`,
      title: capture.title,
      area: capture.area,
      priority: capture.priority,
      dueDate: capture.dueDate,
      doneTest: "Complete the named next action."
    },
    addToTop3: false,
    googleTasks,
    now,
    clearConversation: false
  });
}

function cairoDateTimeToUtcForReminder(dateKey, time) {
  const [hour, minute] = time.split(":").map(Number);
  const utc = new Date(`${dateKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const offset = Number(cairoOffsetMinutes(utc));
  return new Date(utc.getTime() - offset * 60_000).toISOString();
}

function cairoOffsetMinutes(date) {
  const month = date.getUTCMonth();
  return month >= 3 && month <= 9 ? 180 : 120;
}

function parseQuietDuration(text) {
  const match = String(text || "").trim().match(/^(\d+(?:\.\d+)?)h$/i);
  if (!match) return null;
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return null;
  return Math.round(hours * 60);
}

async function showNextRecommendation({ db, user, now }) {
  const date = cairoDateKey(now);
  const outcomes = await db.prepare(
    `SELECT area, outcome, status
       FROM daily_outcomes
      WHERE outcome_date = ?1
      ORDER BY updated_at DESC, rowid DESC`
  ).bind(date).all();
  const latest = new Map();
  for (const row of outcomes.results) {
    if (!latest.has(row.area)) latest.set(row.area, row);
  }
  const openAreas = ["DEEP", "WORK", "LIFE"].filter(area => {
    const outcome = latest.get(area);
    return outcome && !["Completed", "Dropped"].includes(outcome.status);
  });
  if (!openAreas.length) {
    return response("Next", say("tasks_clear", { now }));
  }
  const hour = Number(cairoTimeParts(now).hour);
  const area = hour < 14
    ? (openAreas.includes("DEEP") ? "DEEP" : openAreas[0])
    : hour >= 14 && hour < 15
      ? (openAreas.includes("WORK") ? "WORK" : openAreas[0])
      : hour >= 23
        ? (openAreas.includes("LIFE") ? "LIFE" : openAreas[0])
        : openAreas[0];
  const outcome = latest.get(area);
  const duration = await getDefaultFocusDuration(db, user.id, area, now);
  return {
    category: "Next",
    title: "Next",
    sections: [{ heading: "", lines: [`Next: ${outcome.outcome} · ${duration} min`] }],
    actions: [[
      { label: "Start", action: `start_outcome|${area}` },
      { label: "Other", action: "focus_now" }
    ]]
  };
}

async function getDefaultFocusDuration(db, userId, area, now) {
  const start = shiftDateKey(cairoDateKey(now), -14);
  const result = await db.prepare(
    `SELECT duration_minutes, COUNT(*) AS count
       FROM focus_sessions
      WHERE user_id = ?1 AND area = ?2
        AND substr(started_at, 1, 10) >= ?3
      GROUP BY duration_minutes
      ORDER BY count DESC, duration_minutes DESC
      LIMIT 1`
  ).bind(userId, area, start).first();
  return result && (Number(result.duration_minutes) === 25 || Number(result.duration_minutes) === 50)
    ? Number(result.duration_minutes)
    : 25;
}

async function handleUserReminderCommand({ db, user, intent, now }) {
  const argumentsText = String(intent.arguments || "").trim();
  if (!argumentsText) {
    const result = await listPendingUserReminders(db, user.id, 8);
    const lines = result.results.length
      ? result.results.map(row => {
          const status = row.status === "uncertain"
            ? " · not sure it arrived"
            : row.status === "missed"
              ? " · missed"
              : "";
          return `⏰ ${shortDate(row.remind_at_utc)} · ${timeLabel(row.remind_at_utc)} · ${row.text}${status}`;
        })
      : ["No pending reminders."];
    const actions = result.results.slice(0, 3).map(row => ({
      label: "✖ Cancel",
      action: `reminder_cancel|${row.id}`
    }));
    return {
      category: "Reminders",
      title: "",
      sections: [{ heading: "", lines: [...lines, "How: /remind 5pm call Ahmed"] }],
      actions: actions.length ? [actions] : []
    };
  }
  const parsed = parseUserReminder(argumentsText, now);
  if (!parsed) return response("Reminder", "Add reminder text and a time.");
  if (parsed.pastTime) return response("Reminder", "That time has passed. Choose a future time.");
  if (!parsed.dueAtUtc) {
    await setConversationState(db, user.id, {
      type: "reminder_time",
      text: parsed.text
    }, now.toISOString());
    return {
      category: "Reminder",
      title: "",
      sections: [{ heading: "", lines: ["When should I remind you?"] }],
      actions: [[
        { label: "9:00 AM", action: "reminder_time|09:00" },
        { label: "12:00 PM", action: "reminder_time|12:00" },
        { label: "5:00 PM", action: "reminder_time|17:00" }
      ], [{ label: "Custom", action: "reminder_time|custom" }]]
    };
  }
  await createUserReminder({
    db,
    user,
    text: parsed.text,
    dueAtUtc: parsed.dueAtUtc,
    now: now.toISOString()
  });
  return response("Reminder", `Got it. I'll remind you to “${parsed.text}” at ${timeLabel(parsed.dueAtUtc)}. ⏰`);
}

async function updateToneSetting(db, argumentsText, now) {
  const tone = String(argumentsText || "").trim().toLowerCase();
  if (!["cheeky", "gentle"].includes(tone)) {
    return response("Vibe", "Use /vibe cheeky or /vibe gentle.");
  }
  await db.prepare(
    `INSERT INTO settings (setting_key, setting_value, description, category, updated_at)
     VALUES ('tone', ?1, 'Friendly check-in tone', 'Companion', ?2)
     ON CONFLICT(setting_key) DO UPDATE SET
       setting_value = excluded.setting_value,
       updated_at = excluded.updated_at`
  ).bind(tone, now.toISOString()).run();
  return response("Vibe", tone === "gentle" ? "Gentle mode is on." : "Cheeky mode is on.");
}

async function showPulseStatus(db, userId, now) {
  const date = cairoDateKey(now);
  const result = await db.prepare(
    `SELECT slot, status, reason, nudge_count, sent_at
       FROM work_pulses
      WHERE user_id = ?1 AND cairo_date = ?2
      ORDER BY scheduled_at`
  ).bind(userId, date).all();
  const lines = result.results.length
    ? result.results.map(row => `${row.slot}: ${row.status}${row.reason ? ` · ${row.reason}` : ""}${row.nudge_count ? ` · ${row.nudge_count} nudge` : ""}`)
    : ["No pulses sent today."];
  return response("Work pulses", lines.join("\n"));
}

function titleCase(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1).toLower();
}

async function handlePulseAction({ db, user, identifier, googleTasks, now }) {
  const parts = identifier.split("|");
  const type = parts[1];
  const area = parts[parts.length - 1];
  await db.prepare(
    `UPDATE work_pulses
        SET status = 'answered', response = ?1
      WHERE user_id = ?2 AND cairo_date = ?3 AND status = 'sent'`
  ).bind(type, user.id, cairoDateKey(now)).run();
  if (type === "reason") {
    const reason = parts[2];
    const text = say(`reason_${reason}`, { now, task: "this task" });
    return {
      category: "Pulse response",
      title: "",
      sections: [{ heading: "", lines: [text] }],
      actions: reason === "too_big"
        ? [[{ label: "Start 25 min", action: `start_outcome|${area}` }, { label: "Keep as is", action: "home" }]]
        : reason === "low_energy"
          ? [[{ label: "Start 25 min", action: `start_outcome|${area}` }, { label: "Tomorrow", action: "tomorrow" }]]
          : reason === "pulled_away"
            ? [[{ label: "Start now", action: `start_outcome|${area}` }, { label: "Move it", action: "tomorrow" }]]
            : reason === "forgot"
              ? [[{ label: "Start now", action: `start_outcome|${area}` }]]
              : [[
                  { label: "Keep", action: "home" },
                  { label: "Reschedule", action: "tomorrow" },
                  { label: "Drop today's outcome", action: `outcome_drop|${cairoDateKey(now)}|${area}` }
                ]]
    };
  }
  if (type === "done") {
    const outcome = await getDailyOutcome(db, cairoDateKey(now), area);
    if (outcome && outcome.google_task_id && googleTasks) {
      const task = await db.prepare("SELECT status FROM tasks WHERE google_task_id = ?1")
        .bind(outcome.google_task_id).first();
      if (task && task.status === "Pending") {
        const completed = await googleTasks.complete(outcome.google_task_id);
        await upsertGoogleTaskMirror(db, completed, now.toISOString());
        return response("Pulse completed", say("done_one", { name: await getDisplayName(db), task: outcome.outcome, now }));
      }
    }
    return response("Pulse recorded", "Task status remains unchanged until Google Tasks confirms completion.");
  }
  if (type === "switch") return beginFocusNow({ db, user, now });
  if (type === "blocked") return {
    category: "Pulse blocked",
    title: "What is blocking it?",
    sections: [],
    actions: [[
      { label: "Unclear next step", action: `fr|none|unclear` },
      { label: "Low energy", action: `fr|none|energy` }
    ], [{ label: "External dependency", action: `fr|none|external` }]]
  };
  return response("Pulse recorded", "Got it. No task status was changed.");
}

function response(category, text) {
  return {
    category,
    title: "",
    sections: [{ heading: "", lines: [text] }],
    actions: [],
    replyKeyboardRows: [
      ["▶️ Go", "📝 Drop it"],
      ["🧭 Where I'm at", "🗓 Plan"],
      ["😴 Zzz", "📱 HQ"]
    ]
  };
}

async function syncTaskList({ db, googleTasks, now }) {
  try {
    const tasks = await googleTasks.listAll();
    await syncGoogleTaskMirrors(db, tasks, now.toISOString());
    await logSyncEvent(db, {
      source: "Google Tasks",
      operation: "Synchronize task list",
      occurredAt: now.toISOString(),
      result: "Success",
      errorDetails: `${tasks.length} task(s)`
    });
  } catch (error) {
    await logSyncEvent(db, {
      source: "Google Tasks",
      operation: "Synchronize task list",
      occurredAt: now.toISOString(),
      result: "Failed",
      errorDetails: formatGoogleErrorDetails(error)
    });
    throw error;
  }
}

function formatGoogleErrorDetails(error) {
  if (error && error.oauthErrorCode) {
    return `OAuth ${error.oauthErrorCode}${error.status ? ` (HTTP ${Number(error.status)})` : ""}`;
  }
  if (error && error.googleApiReason) {
    return `Google API ${error.googleApiReason}${error.status ? ` (HTTP ${Number(error.status)})` : ""}`;
  }
  if (error && Number.isInteger(Number(error.status))) {
    return `HTTP ${Number(error.status)}`;
  }
  return error && error.name ? String(error.name) : "Error";
}

function formatCalendarFailureGuidance(errorDetails) {
  if (errorDetails && errorDetails.includes("insufficientPermissions")) {
    return "Google denied Calendar access. Reauthorize the existing Google connection with the required Calendar scope.";
  }
  if (errorDetails && errorDetails.includes("accessNotConfigured")) {
    return "Enable the Google Calendar API in the Cloud project used by the configured OAuth client.";
  }
  return "Check the Google Calendar API and the Calendar access granted to the configured Google account.";
}

function cairoDateKey(date) {
  return formattedCairoDateKey(date);
}

function formatCairoDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "Date unavailable");
  return dateTimeLabel(date);
}

function truncate(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function formatCairoTime(date) {
  return timeLabel(date);
}
