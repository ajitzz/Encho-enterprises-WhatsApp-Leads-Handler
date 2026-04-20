#!/usr/bin/env node

/**
 * Estimate Neon monthly network transfer from Cloudflare Workers edge metrics.
 *
 * This complements lead-based forecasting by using observed request volumes/status
 * mixes from Cloudflare and mapping them to expected DB transfer intensity.
 */

const envNumber = (name, fallback) => {
  const value = Number.parseFloat(process.env[name] || `${fallback}`);
  return Number.isFinite(value) ? value : fallback;
};

const requests24h = envNumber('CF_REQUESTS_24H', 16000);
const ratio2xx = envNumber('RATIO_2XX', 0.31);
const ratio3xx = envNumber('RATIO_3XX', 0.38);
const ratio4xx = envNumber('RATIO_4XX', 0.31);
const ratio5xx = envNumber('RATIO_5XX', 0.0005);

const avgDbTouches2xx = envNumber('DB_TOUCHES_2XX', 1.6);
const avgDbTouches3xx = envNumber('DB_TOUCHES_3XX', 0.15);
const avgDbTouches4xx = envNumber('DB_TOUCHES_4XX', 0.25);
const avgDbTouches5xx = envNumber('DB_TOUCHES_5XX', 0.6);

const kbPerDbTouch = envNumber('KB_PER_DB_TOUCH', 2.4);
const cacheHitRatio = envNumber('CACHE_HIT_RATIO', 0.7);
const writeBatchSize = Math.max(1, envNumber('WRITE_BATCH_SIZE', 4));
const retryMultiplier = Math.max(1, envNumber('RETRY_MULTIPLIER', 1.05));
const safetyFactor = envNumber('SAFETY_FACTOR', 1.1);
const monthlyBudgetGb = envNumber('MONTHLY_BUDGET_GB', 5);

const normalizeRatios = (values) => {
  const sum = values.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (sum <= 0) return [1, 0, 0, 0];
  return values.map((value) => Math.max(0, value) / sum);
};

const [normalized2xx, normalized3xx, normalized4xx, normalized5xx] = normalizeRatios([
  ratio2xx,
  ratio3xx,
  ratio4xx,
  ratio5xx,
]);

const daysPerMonth = 30.4375;
const requestsMonth = requests24h * daysPerMonth;

const requests2xx = requestsMonth * normalized2xx;
const requests3xx = requestsMonth * normalized3xx;
const requests4xx = requestsMonth * normalized4xx;
const requests5xx = requestsMonth * normalized5xx;

const rawTouches =
  requests2xx * avgDbTouches2xx +
  requests3xx * avgDbTouches3xx +
  requests4xx * avgDbTouches4xx +
  requests5xx * avgDbTouches5xx;

const effectiveTouches = rawTouches * (1 - cacheHitRatio) * retryMultiplier;
const batchedTouchEquivalent = effectiveTouches / writeBatchSize;
const transferKb = batchedTouchEquivalent * kbPerDbTouch * safetyFactor;
const transferGb = transferKb / (1024 * 1024);
const utilizationPct = (transferGb / monthlyBudgetGb) * 100;
const headroomGb = monthlyBudgetGb - transferGb;

const print = (label, value) => {
  console.log(`${label.padEnd(42)} ${value}`);
};

const riskBand = () => {
  if (utilizationPct < 40) return 'Low risk';
  if (utilizationPct < 70) return 'Moderate risk';
  if (utilizationPct < 90) return 'High risk';
  return 'Critical risk';
};

console.log('--- Neon Transfer Estimator from Cloudflare Edge Metrics ---');
print('Cloudflare requests / 24h:', requests24h.toFixed(0));
print('Estimated monthly edge requests:', requestsMonth.toFixed(0));
print('2xx / 3xx / 4xx / 5xx mix:', `${(normalized2xx * 100).toFixed(1)}% / ${(normalized3xx * 100).toFixed(1)}% / ${(normalized4xx * 100).toFixed(1)}% / ${(normalized5xx * 100).toFixed(2)}%`);
print('Raw DB touch estimate:', rawTouches.toFixed(0));
print('Cache hit ratio:', `${(cacheHitRatio * 100).toFixed(1)}%`);
print('Write batch size:', writeBatchSize.toFixed(1));
print('Retry multiplier:', retryMultiplier.toFixed(2));
print('Effective DB touch equivalent:', batchedTouchEquivalent.toFixed(0));
print('Monthly transfer estimate (GB):', transferGb.toFixed(3));
print('Monthly budget (GB):', monthlyBudgetGb.toFixed(3));
print('Budget utilization:', `${utilizationPct.toFixed(2)}%`);
print('Headroom (GB):', headroomGb.toFixed(3));
print('Risk band:', riskBand());

if (transferGb > monthlyBudgetGb) {
  console.log('\nResult: projected over budget. Cut 3xx/4xx volume and enforce edge cache + dedupe immediately.');
} else {
  console.log('\nResult: projected within budget under current assumptions. Keep 20% safety buffer.');
}
