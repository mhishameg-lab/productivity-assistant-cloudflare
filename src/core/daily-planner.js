import { shortDate } from "./format.js";
const MAX_TASKS_PER_SECTION = 3;

export function buildDailyTaskPlan(tasks, date) {
  if (!Array.isArray(tasks) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new TypeError("Daily planning requires tasks and a YYYY-MM-DD date.");
  }
  const candidateLimitReached = tasks.length > 100;
  const pending = tasks.slice(0, 100).filter(task => task.status === "Pending");
  const must = [];
  const should = [];
  const canWait = [];

  for (const task of pending) {
    if (task.due_date && task.due_date <= date) {
      must.push(task);
    } else if (
      task.priority === "High" ||
      Number(task.linked_goal_count) > 0 ||
      Number(task.postponement_count) >= 3
    ) {
      should.push(task);
    } else {
      canWait.push(task);
    }
  }

  must.sort((left, right) =>
    compareText(left.due_date, right.due_date) ||
    comparePriority(left.priority, right.priority) ||
    Number(right.postponement_count || 0) - Number(left.postponement_count || 0) ||
    compareText(left.title, right.title)
  );
  should.sort((left, right) =>
    Number(right.linked_goal_count > 0) - Number(left.linked_goal_count > 0) ||
    comparePriority(left.priority, right.priority) ||
    compareOptionalDate(left.due_date, right.due_date) ||
    Number(right.postponement_count || 0) - Number(left.postponement_count || 0) ||
    compareText(left.title, right.title)
  );
  canWait.sort((left, right) =>
    compareOptionalDate(left.due_date, right.due_date) ||
    compareText(left.title, right.title)
  );

  return {
    must: must.slice(0, MAX_TASKS_PER_SECTION),
    mustCount: must.length,
    should: should.slice(0, MAX_TASKS_PER_SECTION),
    shouldCount: should.length,
    canWait: canWait.slice(0, MAX_TASKS_PER_SECTION),
    canWaitCount: canWait.length,
    pendingCount: pending.length,
    candidateLimitReached
  };
}

export function formatDailyTaskPlan(plan, date, currentDate = date) {
  const dayLabel = date === currentDate
    ? "today"
    : date === addDateKey(currentDate, 1)
      ? "tomorrow"
      : `on ${date}`;
  const sections = [
    {
      heading: `Must do ${dayLabel} · overdue or due by ${shortDate(date)}`,
      lines: formatTaskLines(plan.must, plan.mustCount, task => {
        const due = task.due_date < currentDate
          ? `overdue since ${shortDate(task.due_date)}`
          : task.due_date < date
            ? `due ${shortDate(task.due_date)} before this plan`
            : `due ${dayLabel}`;
        return `${task.title} · ${due}${formatPriority(task.priority)}${formatGoal(task)}${formatPostponements(task)}`;
      }, `No tasks are due on or before ${date}.`)
    },
    {
      heading: `Should do ${dayLabel} · high priority, goal-linked, or repeatedly postponed`,
      lines: formatTaskLines(plan.should, plan.shouldCount, task => {
        const goal = task.linked_goal_title ? ` · supports ${task.linked_goal_title}` : "";
        const due = task.due_date ? ` · due ${shortDate(task.due_date)}` : "";
        return `${task.title}${formatPriority(task.priority)}${goal}${due}${formatPostponements(task)}`;
      }, "No other task currently meets these signals.")
    },
    {
      heading: "Can wait",
      lines: formatTaskLines(plan.canWait, plan.canWaitCount, task =>
        `${task.title}${formatPriority(task.priority)}${formatGoal(task)}${task.due_date ? ` · due ${shortDate(task.due_date)}` : ""}`,
      "No lower-priority pending tasks.")
    }
  ];

  if (plan.mustCount > MAX_TASKS_PER_SECTION) {
    sections.push({
      heading: "Deadline load check",
      lines: [
        `${plan.candidateLimitReached ? "At least " : ""}${plan.mustCount} tasks have deadlines on or before ${date}. This count cannot confirm capacity without duration estimates; review priorities. Nothing has been rescheduled.`
      ]
    });
  }
  if (plan.candidateLimitReached) {
    sections.push({
      heading: "Task list limit",
      lines: ["This view is limited to the first 100 pending Google Tasks. Use /tasks to browse the full synchronized list."]
    });
  }
  return sections.filter(section => section.lines && section.lines.length);
}

function addDateKey(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function formatTaskLines(tasks, total, format, emptyText) {
  if (!total) return [];
  const lines = tasks.map(format);
  if (total > tasks.length) lines.push(`And ${total - tasks.length} more; use /tasks to review them.`);
  return lines;
}

function formatPriority(priority) {
  return priority && priority !== "Medium" ? ` · ${priority} priority` : "";
}

function formatGoal(task) {
  return task.linked_goal_title ? ` · supports ${task.linked_goal_title}` : "";
}

function formatPostponements(task) {
  const count = Number(task.postponement_count || 0);
  return count >= 3 ? ` · postponed ${count} times` : "";
}

function comparePriority(left, right) {
  const rank = { High: 0, Medium: 1, Low: 2 };
  return (rank[left] ?? 3) - (rank[right] ?? 3);
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""));
}

function compareOptionalDate(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return compareText(left, right);
}
