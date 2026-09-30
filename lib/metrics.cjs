'use strict';
// Token usage and USD accounting shared by provider/main. Providers use OpenAI's snake_case
// token names; persisted UI metrics use camelCase and integer micro-USD so totals never drift
// through floating point addition. Missing provider usage/prices stay explicitly unknown—zero is
// a real price and must never be used as a fallback for absent data.
const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_PRICE_PER_MILLION = 1_000_000;
const MAX_ROUNDS = 64;

const token = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_COUNT ? value : null;
const price = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE_PER_MILLION ? value : null;
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
  ? value.trim() : '';

/** A provider model's chat pricing (USD per million tokens), or null values when not supplied. */
function normalizePricing(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const inputPerMillion = price(source.inputPerMillion ?? source.input_per_million);
  const outputPerMillion = price(source.outputPerMillion ?? source.output_per_million);
  const currency = text(source.currency, 8).toUpperCase();
  // This feature reports USD only. A provider that reports another currency remains unpriced.
  return {
    currency: currency === 'USD' ? 'USD' : '',
    inputPerMillion,
    outputPerMillion,
  };
}

/** Provider/OpenAI usage -> persisted application naming. */
function normalizeUsage(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const inputTokens = token(source.inputTokens ?? source.prompt_tokens);
  const outputTokens = token(source.outputTokens ?? source.completion_tokens);
  const totalTokens = token(source.totalTokens ?? source.total_tokens);
  const usage = {};
  if (inputTokens !== null) usage.inputTokens = inputTokens;
  if (outputTokens !== null) usage.outputTokens = outputTokens;
  if (totalTokens !== null) usage.totalTokens = totalTokens;
  return Object.keys(usage).length ? usage : null;
}

function nanoUsd(usage, pricing) {
  if (!usage || !pricing || pricing.currency !== 'USD'
    || !Number.isInteger(usage.inputTokens) || !Number.isInteger(usage.outputTokens)
    || pricing.inputPerMillion === null || pricing.outputPerMillion === null) return null;
  // USD/million × tokens = micro-USD; retain 1/1000 micro-USD for stable task totals.
  const value = Math.round((usage.inputTokens * pricing.inputPerMillion + usage.outputTokens * pricing.outputPerMillion) * 1000);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function microUsd(usage, pricing) {
  const nano = nanoUsd(usage, pricing);
  return nano === null ? null : Math.round(nano / 1000);
}

function roundMetric(value, fallbackPricing) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const usage = normalizeUsage(source.usage || source);
  const pricing = normalizePricing(source.pricing || fallbackPricing);
  const model = text(source.model, 256);
  const result = {};
  if (model) result.model = model;
  if (usage) result.usage = usage;
  if (pricing.currency || pricing.inputPerMillion !== null || pricing.outputPerMillion !== null) result.pricing = pricing;
  const costNanoUsd = nanoUsd(usage, pricing);
  if (costNanoUsd !== null) {
    result.costNanoUsd = costNanoUsd;
    result.costMicroUsd = Math.round(costNanoUsd / 1000);
  }
  return Object.keys(result).length ? result : null;
}

/**
 * Final, persisted metrics for a chat reply or no-tools compaction request. `usageRounds` holds
 * every model completion in a tool loop, so the UI can explain the total without estimating.
 */
function createMetrics({ model, usage, pricing, usageRounds, incomplete = false } = {}) {
  const normalizedUsage = normalizeUsage(usage);
  const normalizedPricing = normalizePricing(pricing);
  const rounds = [];
  if (Array.isArray(usageRounds)) {
    for (const item of usageRounds.slice(0, MAX_ROUNDS)) {
      const entry = roundMetric(item, normalizedPricing);
      if (entry) rounds.push(entry);
    }
  }
  const result = {};
  const modelName = text(model, 256);
  if (modelName) result.model = modelName;
  if (normalizedUsage) result.usage = normalizedUsage;
  if (normalizedPricing.currency || normalizedPricing.inputPerMillion !== null || normalizedPricing.outputPerMillion !== null) {
    result.pricing = normalizedPricing;
  }
  if (rounds.length) result.rounds = rounds;
  const costNanoUsd = nanoUsd(normalizedUsage, normalizedPricing);
  if (costNanoUsd !== null) {
    result.costNanoUsd = costNanoUsd;
    result.costMicroUsd = Math.round(costNanoUsd / 1000);
    result.costStatus = incomplete ? 'incomplete' : 'priced';
  } else if (normalizedUsage) {
    result.costStatus = incomplete ? 'incomplete' : normalizedPricing.currency ? 'incomplete' : 'unpriced';
  } else {
    result.costStatus = incomplete ? 'incomplete' : 'unreported';
  }
  // No model, usage or pricing means the provider had nothing measurable to preserve.
  return modelName || normalizedUsage || rounds.length || result.pricing ? result : null;
}

module.exports = { normalizePricing, normalizeUsage, createMetrics, microUsd, nanoUsd, MAX_ROUNDS };
