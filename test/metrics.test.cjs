'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePricing, normalizeUsage, createMetrics, microUsd } = require('../lib/metrics.cjs');

test('normalizes USD per-million pricing and OpenAI usage without turning missing values into zero', () => {
  assert.deepEqual(normalizePricing({ input_per_million: 0.19, output_per_million: 0.51, currency: 'USD' }), {
    inputPerMillion: 0.19, outputPerMillion: 0.51, currency: 'USD',
  });
  assert.deepEqual(normalizePricing({ inputPerMillion: 0, outputPerMillion: 0, currency: 'usd' }), {
    inputPerMillion: 0, outputPerMillion: 0, currency: 'USD',
  });
  assert.deepEqual(normalizePricing({ inputPerMillion: 1, outputPerMillion: 2, currency: 'EUR' }), {
    inputPerMillion: 1, outputPerMillion: 2, currency: '',
  });
  assert.equal(normalizeUsage({ total_tokens: 12 }).inputTokens, undefined);
  assert.deepEqual(normalizeUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }), {
    inputTokens: 5, outputTokens: 2, totalTokens: 7,
  });
});

test('calculates stable integer micro-USD only when both token sides and USD prices are known', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const pricing = { inputPerMillion: 0.19, outputPerMillion: 0.51, currency: 'USD' };
  assert.equal(microUsd(usage, pricing), 700000);
  assert.equal(microUsd({ totalTokens: 12 }, pricing), null);
  assert.equal(microUsd(usage, { ...pricing, currency: '' }), null);
});

test('keeps a per-round model usage ledger alongside a final reply total', () => {
  const metrics = createMetrics({
    model: 'demo',
    usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 },
    pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
    usageRounds: [
      { model: 'demo', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      { model: 'demo', usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } },
    ],
  });
  assert.deepEqual(metrics.usage, { inputTokens: 14, outputTokens: 5, totalTokens: 19 });
  assert.equal(metrics.costMicroUsd, 24);
  assert.equal(metrics.costStatus, 'priced');
  assert.deepEqual(metrics.rounds.map((round) => round.usage.totalTokens), [7, 12]);
});

test('keeps usage visible when a provider does not disclose usable prices', () => {
  const metrics = createMetrics({ model: 'custom', usage: { total_tokens: 12 } });
  assert.deepEqual(metrics.usage, { totalTokens: 12 });
  assert.equal(metrics.costStatus, 'unpriced');
  assert.equal('costMicroUsd' in metrics, false);
});


test('retains nano-USD precision so a task can sum small independently rounded replies', () => {
  const pricing = { inputPerMillion: 0.19, outputPerMillion: 0, currency: 'USD' };
  const one = createMetrics({ model: 'tiny', usage: { prompt_tokens: 1, completion_tokens: 0 }, pricing });
  assert.equal(one.costMicroUsd, 0, 'one reply rounds to zero micro-USD for display');
  assert.equal(one.costNanoUsd, 190);
  assert.equal(Array.from({ length: 10 }, () => one.costNanoUsd).reduce((sum, item) => sum + item, 0), 1900, 'the task can display two micro-USD after summing');
});
