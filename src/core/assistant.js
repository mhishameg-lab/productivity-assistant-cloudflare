import {
  appendFocusOutcomeStatus,
  listPendingTaskMirrors,
  syncGoogleTaskMirrors,
  upsertGoogleTaskMirror
} from "../db/google-tasks-repository.js";
import {
  clearConversationState,
  getConversationState,
  getTaskCreationRequest,
  logSyncEvent,
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
import { resolveIntent } from "./intent.js";

export async function handleAssistantMessage({
  db,
  user,
  message,
  googleTasks,
  googleCalendar = null,
  now
}) {
  const intent = resolveIntent(message);
  if (intent.type === "user_action") {
    return handleAction({ db, user, message, intent, googleTasks, googleCalendar, now });
  }

  if (intent.type === "unknown_command") {
    return response("Unknown command", "I don't recognize that shortcut. Use /help to see what you can do.");
  }
  if (intent.type === "unsupported_input") return null;
  if (intent.type === "user_message") {
    const state = await getConversationState(db, user.id, now.toISOString());
    if (state) {
      return handleConversationText({
        db, user, message, state, googleTasks, googleCalendar, now
      });
    }
    return response("Message", "Use /addtask to capture a next action, or /help to see the control panel.");
  }

  switch (intent.name) {
    case "start":
    case "today":
      return showHome({ db, googleTasks, googleCalendar, now });
    case "help":
      return {
        category: "Control panel",
        title: "What do you need?",
        sections: [{
          heading: "",
          lines: [
            "Plan my day",
            "Add a task",
            "Focus now",
            "Review progress",
            "Capture an idea",
            "Weekly review",
            "Monthly project decision",
            "Settings",
            "Shortcuts: /today · /tasks · /addtask · /weekly · /monthly"
          ]
        }],
        actions: [[
          { label: "Add a task", action: "add_task" },
          { label: "Show tasks", action: "show_tasks" }
        ], [
          { label: "Weekly review", action: "weekly_start" },
          { label: "Monthly project", action: "monthly_project_review" }
        ]]
      };
    case "tasks":
      return showTasks({ db, googleTasks, now });
    case "tomorrow":
      return showPlanForDate({
        db,
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
    case "focus":
      return beginFocusNow({ db, user, now });
    default:
      return response(
        "Migration status",
        "That workflow is not migrated yet. Use /help to see the available controls."
      );
  }
}

async function handleAction({ db, user, message, intent, googleTasks, googleCalendar, now }) {
  const identifier = intent.identifier;
  if (identifier === "home") return showHome({ db, googleTasks, googleCalendar, now });
  if (identifier === "show_tasks") return showTasks({ db, googleTasks, now });
  if (identifier === "add_task") return beginTaskCapture(db, user, now);
  if (identifier === "focus_now") return beginFocusNow({ db, user, now });
  if (identifier === "plan_next_day_now") return beginNextDayPlanning({ db, user, now });
  if (identifier === "plan_my_day") {
    return {
      ...(await showPlanForDate({
        db,
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
        lines: ["Reply with a Cairo-local start time: YYYY-MM-DD HH:mm"]
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
              "Reply with a date as YYYY-MM-DD.",
              "The task due date will move in Google Tasks. A Calendar block is not created by this Worker yet."
            ]
          }],
          inputMode: "force_reply",
          inputPlaceholder: "YYYY-MM-DD"
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
  await setConversationState(db, user.id, {
    type: "weekly_review",
    index: 0,
    date: cairoDateKey(now),
    runId: crypto.randomUUID()
  }, now.toISOString(), 7200);
  return planningQuestion(`Weekly review 1/${questions.length}`, questions[0].text);
}

async function beginMonthlyProjectReview({ db, user, now }) {
  await setConversationState(db, user.id, {
    type: "monthly_project_name",
    date: cairoDateKey(now),
    runId: crypto.randomUUID()
  }, now.toISOString(), 7200);
  return {
    category: "Monthly project review",
    title: "Choose a project to review",
    sections: [{ heading: "", lines: ["Every project needs a reason and a review date."] }],
    inputMode: "force_reply",
    inputPlaceholder: "Project name"
  };
}

function getWeeklyReviewQuestions() {
  return [
    {
      text: "On how many days did you complete your DEEP, WORK, and LIFE outcomes? Which areas felt clear?",
      area: "DEEP/WORK/LIFE"
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

async function handleConversationText({
  db,
  user,
  message,
  state,
  googleTasks,
  googleCalendar,
  now
}) {
  const text = String(message.message.text || "").trim();
  if (!text) return null;

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
    if (!isValidDateKey(text)) {
      return response("Date format needed", "Enter a valid date as YYYY-MM-DD.");
    }
    if (text < cairoDateKey(now)) {
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
        const task = await googleTasks.reschedule(session.google_task_id, text);
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
      const details = `Moved to ${text}. Calendar block not created; the Worker Calendar integration is pending.`;
      await appendOutcomeIfChanged(db, outcome, "Rescheduled", details, now);
      await finalizeFocusSessionResponse(db, session.id, "Rescheduled", details, now);
      await clearConversationState(db, user.id);
      return {
        category: "Outcome rescheduled",
        title: "Task due date moved",
        sections: [{
          heading: "",
          lines: [
            `Google Tasks due date: ${text}`,
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
    return planningQuestion("Plan tomorrow — 2/5", "What is the one DEEP growth outcome?");
  }

  if (state.type === "next_day_deep") {
    if (text.length > 500) return response("Outcome too long", "Keep the DEEP outcome under 500 characters.");
    await setConversationState(db, user.id, {
      type: "next_day_work",
      date: state.date,
      reviewDate: state.reviewDate,
      runId: state.runId,
      deep: text
    }, now.toISOString());
    return planningQuestion("Plan tomorrow — 3/5", "What is the one WORK / SDR outcome?");
  }

  if (state.type === "next_day_work") {
    if (text.length > 500) return response("Outcome too long", "Keep the WORK outcome under 500 characters.");
    await setConversationState(db, user.id, {
      type: "next_day_life",
      date: state.date,
      reviewDate: state.reviewDate,
      runId: state.runId,
      deep: state.deep,
      work: text
    }, now.toISOString());
    return planningQuestion("Plan tomorrow — 4/5", "What is the one LIFE health or admin outcome?");
  }

  if (state.type === "next_day_life") {
    if (text.length > 500) return response("Outcome too long", "Keep the LIFE outcome under 500 characters.");
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
    return planningQuestion("Work briefing — 2/3", "What is your hypothesis for reaching that target?");
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
    return planningQuestion("Work briefing — 3/3", "What is one learning question to test during the shift?");
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
        [{ label: "Start WORK", action: "start_outcome|WORK" }],
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
    const match = text.match(/^(\d{4}-\d{2}-\d{2}) ([0-2]\d):([0-5]\d)$/);
    if (!match || !isValidDateKey(match[1]) || Number(match[2]) > 23) {
      return response(
        "Enter a valid Cairo start time",
        "Use YYYY-MM-DD HH:mm in Cairo time, for example 2026-11-23 09:00."
      );
    }
    state.type = "calendar_block_duration";
    state.date = match[1];
    state.startTime = `${match[2]}:${match[3]}`;
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
      inputPlaceholder: "YYYY-MM-DD"
    };
  }

  if (state.type === "monthly_project_review_date") {
    if (!isValidDateKey(text) || text <= cairoDateKey(now)) {
      return response("Choose a future review date", "Enter a future date as YYYY-MM-DD.");
    }
    await recordReviewNote(db, {
      id: `MONTH-${state.runId}`,
      reviewType: "Monthly project decision",
      reviewDate: state.date,
      question: `${state.decision}: ${state.project}; review date ${text}`,
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
          `Review date: ${text}`,
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
          { label: "DEEP", action: "task_area|DEEP" },
          { label: "WORK", action: "task_area|WORK" },
          { label: "LIFE", action: "task_area|LIFE" }
        ],
        [
          { label: "Admin", action: "task_area|Admin" },
          { label: "Other", action: "task_area|Other" }
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

async function createCapturedTask({
  db,
  user,
  state,
  addToTop3,
  googleTasks,
  googleCalendar = null,
  now
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
  await clearConversationState(db, user.id);
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

async function createPlannedOutcomeTask({
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
    return `${index + 1}. ${area} — ${outcome ? outcome.outcome : "Not set yet"}${outcome && outcome.status !== "Planned" ? ` (${outcome.status})` : ""}`;
  });
}

async function showHome({ db, googleTasks, googleCalendar, now }) {
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
    const value = outcome ? outcome.outcome : "Not set yet";
    return `${index + 1}. ${area} — ${value}`;
  });
  const tasks = await listPendingTaskMirrors(db, date, 3, 0);
  const calendarEvents = googleCalendar
    ? await googleCalendar.listEventsForDate(date)
    : [];
  const sections = [{
    heading: "Your three outcomes",
    lines: outcomeLines
  }];
  if (tasks.length) {
    sections.push({ heading: "Next action", lines: [tasks[0].title] });
  }
  if (googleCalendar) {
    sections.push({
      heading: "Today's calendar",
      lines: calendarEvents.length
        ? calendarEvents.map(formatCalendarEvent)
        : ["No appointments today."]
    });
  }
  sections.push({ heading: "", lines: ["What do you want to move forward now?"] });

  return {
    category: "Daily home",
    title: "Good morning.",
    sections,
    actions: [
      [
        { label: "Start DEEP", action: "start_outcome|DEEP" },
        { label: "Start WORK", action: "start_outcome|WORK" }
      ],
      [{ label: "Start LIFE", action: "start_outcome|LIFE" }],
      [
        { label: "Add something", action: "add_task" },
        { label: "Show full plan", action: "show_tasks" }
      ]
    ]
  };
}

async function showPlanForDate({ db, googleTasks, googleCalendar, date, title, now }) {
  if (!isValidDateKey(date)) throw new TypeError("Requested plan date is invalid.");
  if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
  await syncTaskList({ db, googleTasks, now });
  const outcomes = await getDailyOutcomesForDate(db, date);
  const taskResult = await db.prepare(
    `SELECT title, priority
       FROM tasks
      WHERE status = 'Pending' AND due_date = ?1
      ORDER BY CASE priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
               title
      LIMIT 20`
  ).bind(date).all();
  const dueTasks = taskResult.results;
  const calendarEvents = googleCalendar
    ? await googleCalendar.listEventsForDate(date)
    : null;
  return {
    category: "Daily plan",
    title,
    sections: [
      { heading: "DEEP · WORK · LIFE", lines: outcomes },
      {
        heading: "Tasks due",
        lines: dueTasks.length
          ? dueTasks.map(task => `${task.title} — ${task.priority || "Medium"}`)
          : ["No tasks due on this date."]
      },
      {
        heading: "Calendar",
        lines: calendarEvents
          ? calendarEvents.length
            ? calendarEvents.map(formatCalendarEvent)
            : ["No appointments on this date."]
          : ["Calendar integration is disabled until OAuth access is authorized."]
      }
    ],
    actions: [
      [{ label: "Plan tomorrow", action: "plan_next_day_now" }],
      [{ label: "Back to home", action: "home" }]
    ]
  };
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
      sections: [{ heading: "", lines: ["Add a next action and choose DEEP, WORK, or LIFE."] }],
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
      date,
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

function response(category, text) {
  return {
    category,
    title: "",
    sections: [{ heading: "", lines: [text] }],
    actions: []
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
      errorDetails: error && error.name ? String(error.name) : "Error"
    });
    throw error;
  }
}

function cairoDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
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
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
