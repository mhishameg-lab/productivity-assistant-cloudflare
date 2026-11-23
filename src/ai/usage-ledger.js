const MAX_DAILY_NEURONS = 9000;

const MODEL_NEURON_RATES = Object.freeze({
  "@cf/meta/llama-3.1-8b-instruct": {
    inputPerMillion: 25608,
    outputPerMillion: 75147
  },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
    inputPerMillion: 26668,
    outputPerMillion: 204805
  }
});

export async function reserveAiUsage({
  db,
  model,
  inputBytes,
  completionTokens,
  dailyNeuronLimit,
  now
}) {
  const rates = MODEL_NEURON_RATES[model];
  if (!rates) throw new TypeError("Configured Workers AI model is not in the cost-checked allowlist.");
  if (!db || !now || Number.isNaN(Date.parse(now))) {
    throw new TypeError("Workers AI usage reservation requires D1 and a valid timestamp.");
  }
  if (!Number.isInteger(inputBytes) || inputBytes < 0 ||
      !Number.isInteger(completionTokens) || completionTokens < 1) {
    throw new TypeError("Workers AI usage reservation requires valid token estimates.");
  }
  const limit = parseDailyNeuronLimit(dailyNeuronLimit);
  const estimatedNeurons = estimateReservedNeurons(inputBytes, completionTokens, rates);
  const usageDate = new Date(Date.parse(now)).toISOString().slice(0, 10);
  const reservation = await db.prepare(
    `INSERT INTO ai_usage_daily (
       usage_date_utc, request_count, reserved_neurons, failed_request_count, updated_at
     )
     SELECT ?1, 1, ?2, 0, ?3
     WHERE ?2 <= ?4
     ON CONFLICT(usage_date_utc) DO UPDATE SET
       request_count = ai_usage_daily.request_count + 1,
       reserved_neurons = ai_usage_daily.reserved_neurons + excluded.reserved_neurons,
       updated_at = excluded.updated_at
     WHERE ai_usage_daily.reserved_neurons + excluded.reserved_neurons <= ?4
     RETURNING reserved_neurons`
  ).bind(usageDate, estimatedNeurons, new Date(Date.parse(now)).toISOString(), limit).first();
  return reservation ? { usageDate, reservedNeurons: reservation.reserved_neurons } : null;
}

export async function recordAiFailure(db, usageDate, now) {
  await db.prepare(
    `UPDATE ai_usage_daily
        SET failed_request_count = failed_request_count + 1,
            updated_at = ?1
      WHERE usage_date_utc = ?2`
  ).bind(new Date(Date.parse(now)).toISOString(), usageDate).run();
}

function parseDailyNeuronLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DAILY_NEURONS) {
    throw new TypeError(`AI daily neuron limit must be an integer from 1 to ${MAX_DAILY_NEURONS}.`);
  }
  return limit;
}

function estimateReservedNeurons(inputBytes, completionTokens, rates) {
  const inputTokenUpperBound = inputBytes + 32;
  return Math.ceil(inputTokenUpperBound * rates.inputPerMillion / 1_000_000) +
    Math.ceil(completionTokens * rates.outputPerMillion / 1_000_000);
}
