#!/usr/bin/env node

/**
 * Neon transfer estimator for always-on WhatsApp webhook workloads.
 *
 * Models both business traffic (lead + bot flow) and baseline 24/7 transfer
 * from health checks/periodic reads so teams can capacity-plan against a fixed
 * transfer budget.
 *
 * Usage:
 *   node scripts/estimate-network-transfer.js
 *   LEADS_PER_WEEK=300 MSGS_PER_LEAD=18 DOC_RATE=0.2 node scripts/estimate-network-transfer.js
 */

const envNumber = (name, fallback) => {
  const value = Number.parseFloat(process.env[name] || `${fallback}`);
  return Number.isFinite(value) ? value : fallback;
};

const leadsPerWeek = envNumber('LEADS_PER_WEEK', 300);
const weeksPerMonth = envNumber('WEEKS_PER_MONTH', 4.345);
const messagesPerLead = envNumber('MSGS_PER_LEAD', 18);
const docRate = envNumber('DOC_RATE', 0.2);

// Envelope of DB request+response transfer if each message touches Postgres.
const kbPerMessageNoCache = envNumber('KB_PER_MESSAGE', 3.2);

// % of messages served from Redis/session cache with no Postgres read/write.
const cacheHitRatio = envNumber('CACHE_HIT_RATIO', 0.7);

// Batch size for write-behind persistence (1 means no batching).
const writeBatchSize = Math.max(1, envNumber('WRITE_BATCH_SIZE', 4));

// Transfer overhead multiplier for retries / duplicate webhook delivery.
const retryMultiplier = Math.max(1, envNumber('RETRY_MULTIPLIER', 1.05));

// Extra transfer for media metadata row update when only S3 URL is stored.
const kbPerDocument = envNumber('KB_PER_DOCUMENT', 1.5);

// Always-on operational traffic.
const healthChecksPerMinute = envNumber('HEALTH_CHECKS_PER_MINUTE', 1);
const kbPerHealthCheck = envNumber('KB_PER_HEALTH_CHECK', 0.5);
const webhookVerifyCallsPerDay = envNumber('WEBHOOK_VERIFY_CALLS_PER_DAY', 2);
const kbPerWebhookVerify = envNumber('KB_PER_WEBHOOK_VERIFY', 0.3);

// Budget can be tuned for other plans.
const budgetGb = envNumber('MONTHLY_BUDGET_GB', 5);

const monthlyLeads = leadsPerWeek * weeksPerMonth;
const monthlyMessages = monthlyLeads * messagesPerLead;
const monthlyDocuments = monthlyLeads * docRate;

const dbTouchRatio = Math.max(0, 1 - cacheHitRatio);
const effectiveKbPerMessage = (kbPerMessageNoCache * dbTouchRatio * retryMultiplier) / writeBatchSize;

const messageTransferKb = monthlyMessages * effectiveKbPerMessage;
const documentTransferKb = monthlyDocuments * kbPerDocument * retryMultiplier;

const minutesPerMonth = 60 * 24 * 30.4375;
const daysPerMonth = 30.4375;
const healthTransferKb = healthChecksPerMinute * minutesPerMonth * kbPerHealthCheck;
const webhookVerifyTransferKb = webhookVerifyCallsPerDay * daysPerMonth * kbPerWebhookVerify;

const totalKb = messageTransferKb + documentTransferKb + healthTransferKb + webhookVerifyTransferKb;
const totalGb = totalKb / (1024 * 1024);
const headroomGb = budgetGb - totalGb;
const utilizationPct = (totalGb / budgetGb) * 100;

const print = (label, value) => {
  console.log(`${label.padEnd(40)} ${value}`);
};

const grade = () => {
  if (utilizationPct <= 55) return '9.9/10 (Peak-safe)';
  if (utilizationPct <= 70) return '9.3/10 (Strong)';
  if (utilizationPct <= 85) return '8.5/10 (Manageable)';
  if (utilizationPct <= 100) return '7.0/10 (Risky)';
  return '5.0/10 (Over budget)';
};

console.log('--- Neon DB Transfer Estimator (24/7 Webhook + Bot Flow) ---');
print('Leads per week:', leadsPerWeek.toFixed(0));
print('Messages per lead (in+out):', messagesPerLead.toFixed(1));
print('Document share rate:', `${(docRate * 100).toFixed(1)}%`);
print('Estimated monthly leads:', monthlyLeads.toFixed(0));
print('Estimated monthly messages:', monthlyMessages.toFixed(0));
print('Redis cache hit ratio:', `${(cacheHitRatio * 100).toFixed(1)}%`);
print('Write-behind batch size:', writeBatchSize.toFixed(1));
print('Retry multiplier:', retryMultiplier.toFixed(2));
print('Effective KB per message:', effectiveKbPerMessage.toFixed(4));
print('Monthly message transfer (GB):', (messageTransferKb / (1024 * 1024)).toFixed(3));
print('Monthly media metadata transfer (GB):', (documentTransferKb / (1024 * 1024)).toFixed(3));
print('Monthly health-check transfer (GB):', (healthTransferKb / (1024 * 1024)).toFixed(3));
print('Monthly webhook verify transfer (GB):', (webhookVerifyTransferKb / (1024 * 1024)).toFixed(3));
print('Total monthly transfer (GB):', totalGb.toFixed(3));
print('Monthly budget (GB):', budgetGb.toFixed(3));
print('Headroom (GB):', headroomGb.toFixed(3));
print('Budget utilization:', `${utilizationPct.toFixed(2)}%`);
print('Operational grade:', grade());

if (totalGb <= budgetGb) {
  console.log('\nResult: Within budget for 24/7 operations under current assumptions.');
} else {
  console.log('\nResult: Over budget. Increase cache hit ratio, batch writes, reduce read frequency, or upgrade plan.');
}

if (utilizationPct > 80) {
  console.log('Action: Keep a 20% buffer to absorb retries and seasonal message spikes.');
}
