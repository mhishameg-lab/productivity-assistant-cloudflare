import { recordAiFailure, reserveAiUsage } from "./usage-ledger.js";

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_PROMPT_BYTES = 3072;
const MAX_COMPLETION_TOKENS = 64;

const REVIEW_INSTRUCTIONS = [
  "Rank the most useful evidence-based recommendations for this productivity review.",
  "Select only recommendation codes supplied in the context, up to three.",
  "Do not infer causes, invent events, or make claims beyond the supplied measurements.",
  "Return only the JSON object allowed by the response schema."
].join(" ");

export async function prioritizeReviewRecommendations({
  db,
  ai,
  report,
  metrics,
  now,
  model = DEFAULT_MODEL,
  dailyNeuronLimit = 5000
}) {
  if (!ai || typeof ai.run !== "function") return null;
  if (!report || !["weekly", "monthly"].includes(report.type) || !metrics) {
    throw new TypeError("AI review recommendations require a weekly or monthly report.");
  }
  if (!db || !now || Number.isNaN(Date.parse(now))) {
    throw new TypeError("AI review recommendations require D1 and a valid timestamp.");
  }

  const options = buildRecommendationOptions(metrics, report.type);
  if (!options.length) return [];
  const context = {
    reviewType: report.type,
    period: { start: report.start, end: report.end },
    measures: {
      created: metrics.created,
      completed: metrics.completed,
      incomplete: metrics.incomplete,
      overdue: metrics.overdue,
      postponements: metrics.postponements,
      completionRatePercent: Math.round(metrics.completionRate * 100),
      planningConsistencyPercent: metrics.planning,
      goalProgress: (metrics.goalProgress || []).slice(0, 5).map(goal => ({
        title: String(goal.title || "").slice(0, 100),
        progressPercent: goal.progressPercent,
        measurementUpdates: goal.measurementUpdates,
        deadline: goal.deadline || null
      })),
      projectDecisionsRecorded: (metrics.projectDecisions || []).length
    },
    availableRecommendations: options
  };
  const prompt = `${REVIEW_INSTRUCTIONS}\nReview data: ${JSON.stringify(context)}`;
  const promptBytes = new TextEncoder().encode(prompt).byteLength;
  if (promptBytes > MAX_PROMPT_BYTES) return null;

  const reservation = await reserveAiUsage({
    db,
    model,
    inputBytes: promptBytes,
    completionTokens: MAX_COMPLETION_TOKENS,
    dailyNeuronLimit,
    now
  });
  if (!reservation) return null;

  try {
    const result = await ai.run(model, {
      prompt,
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            recommendationCodes: {
              type: "array",
              items: { type: "string", enum: options.map(option => option.code) },
              maxItems: 3,
              uniqueItems: true
            }
          },
          required: ["recommendationCodes"],
          additionalProperties: false
        }
      },
      max_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0
    });
    return parseRecommendations(result, options);
  } catch (error) {
    await recordAiFailure(db, reservation.usageDate, now);
    throw error;
  }
}

export function formatReviewRecommendations(metrics, codes, reportType) {
  const options = new Map(buildRecommendationOptions(metrics, reportType).map(option => [
    option.code,
    option.text
  ]));
  return [...new Set(codes || [])]
    .map(code => options.get(code))
    .filter(Boolean)
    .slice(0, 3);
}

function buildRecommendationOptions(metrics, reportType) {
  const options = [];
  const goals = Array.isArray(metrics.goalProgress) ? metrics.goalProgress : [];
  if (metrics.overdue > 0 || metrics.incomplete > 0) {
    options.push({
      code: "open_responsibilities",
      evidence: `${metrics.incomplete} open task(s), ${metrics.overdue} overdue task(s)`,
      text: "Choose the most important open responsibility and define its next action before adding more work."
    });
  }
  if (metrics.postponements > 0 || (metrics.repeatedProblems || []).length > 0) {
    options.push({
      code: "repeated_delays",
      evidence: `${metrics.postponements} postponement(s) and ${(metrics.repeatedProblems || []).length} repeated problem(s) recorded`,
      text: "Review repeated postponements and make one explicit scope, support, or deadline decision."
    });
  }
  if (metrics.planning < 80) {
    options.push({
      code: "planning_rhythm",
      evidence: `planning consistency was ${metrics.planning}%`,
      text: "Protect a short, realistic planning block; use it to choose fewer priorities rather than expand the task list."
    });
  }
  if (goals.some(goal => !Number(goal.measurementUpdates))) {
    options.push({
      code: "measure_goal_progress",
      evidence: "at least one active objective had no key-result measurement update",
      text: "Record a measurable update for an objective that had no key-result measurement this period."
    });
  }
  if (goals.length && goals.some(goal =>
    goal.deadline && goal.progressPercent != null && goal.progressPercent < 50
  )) {
    options.push({
      code: "protect_strategic_work",
      evidence: "at least one time-bound objective is below 50% measured progress",
      text: "Reserve realistic time for the closest-deadline objective and confirm its next action is still feasible."
    });
  }
  if (reportType === "monthly" && !(metrics.projectDecisions || []).length) {
    options.push({
      code: "review_project_choices",
      evidence: "no monthly project decision was recorded in the period",
      text: "Review active projects and explicitly decide what to continue, change, pause, or stop."
    });
  }
  if (!options.length && metrics.completed > 0) {
    options.push({
      code: "sustain_progress",
      evidence: `${metrics.completed} task(s) were completed and no stronger review signal was identified`,
      text: "Keep the next period sustainable: carry forward only the few open tasks that still matter."
    });
  }
  return options;
}

function parseRecommendations(result, options) {
  let value = result && result.response;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Workers AI returned invalid JSON for review recommendations.");
    }
  }
  const allowedCodes = new Set(options.map(option => option.code));
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.recommendationCodes) ||
    value.recommendationCodes.length > 3 ||
    value.recommendationCodes.some(code =>
      typeof code !== "string" || !allowedCodes.has(code)
    ) ||
    new Set(value.recommendationCodes).size !== value.recommendationCodes.length
  ) {
    throw new Error("Workers AI returned unsupported review recommendations.");
  }
  return value.recommendationCodes;
}
