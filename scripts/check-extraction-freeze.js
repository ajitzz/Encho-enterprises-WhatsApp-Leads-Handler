#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scorecardPath = path.join(root, 'docs/operations/success-scorecard-latest.md');

if (!fs.existsSync(scorecardPath)) {
  console.error('Extraction freeze check failed: missing docs/operations/success-scorecard-latest.md');
  process.exit(1);
}

const scorecard = fs.readFileSync(scorecardPath, 'utf8');

const readPercent = (label) => {
  const regex = new RegExp(`${label}:[^\n]*?([+-]?\\d+(?:\\.\\d+)?)%`, 'i');
  const match = scorecard.match(regex);
  return match ? Number.parseFloat(match[1]) : Number.NaN;
};

const readRate = (label) => {
  const regex = new RegExp(`${label}:[^\n]*?(\\d+(?:\\.\\d+)?)%`, 'i');
  const match = scorecard.match(regex);
  return match ? Number.parseFloat(match[1]) : Number.NaN;
};

const budgets = {
  webhookP95Delta: 5,
  webhookP99Delta: 8,
  leadIngestionFloor: 99,
  reminderSuccessFloor: 99,
};

const metrics = {
  webhookP95Delta: readPercent('webhook latency p95'),
  webhookP99Delta: readPercent('webhook latency p99'),
  leadIngestionRate: readRate('lead ingestion success rate'),
  reminderSuccessRate: readRate('reminder dispatch success'),
};

const problems = [];
if (!Number.isFinite(metrics.webhookP95Delta) || metrics.webhookP95Delta > budgets.webhookP95Delta) {
  problems.push(`webhook latency p95 delta breach (${metrics.webhookP95Delta}% > ${budgets.webhookP95Delta}%)`);
}
if (!Number.isFinite(metrics.webhookP99Delta) || metrics.webhookP99Delta > budgets.webhookP99Delta) {
  problems.push(`webhook latency p99 delta breach (${metrics.webhookP99Delta}% > ${budgets.webhookP99Delta}%)`);
}
if (!Number.isFinite(metrics.leadIngestionRate) || metrics.leadIngestionRate < budgets.leadIngestionFloor) {
  problems.push(`lead ingestion success floor breach (${metrics.leadIngestionRate}% < ${budgets.leadIngestionFloor}%)`);
}
if (!Number.isFinite(metrics.reminderSuccessRate) || metrics.reminderSuccessRate < budgets.reminderSuccessFloor) {
  problems.push(`reminder dispatch success floor breach (${metrics.reminderSuccessRate}% < ${budgets.reminderSuccessFloor}%)`);
}

const freezeActive = problems.length > 0;
const freezeLineRegex = /extraction freeze status:\s*\*\*(active|inactive)\*\*/i;
const freezeLineMatch = scorecard.match(freezeLineRegex);
if (!freezeLineMatch) {
  problems.push('scorecard missing extraction freeze status line');
} else {
  const declaredStatus = freezeLineMatch[1].toLowerCase();
  const shouldBe = freezeActive ? 'active' : 'inactive';
  if (declaredStatus !== shouldBe) {
    problems.push(`declared extraction freeze status mismatch (declared: ${declaredStatus}, expected: ${shouldBe})`);
  }
}

if (problems.length > 0) {
  console.error('Extraction freeze check failed: 신규 extractions are frozen due to KPI/SLO breaches.');
  for (const problem of problems) {
    console.error(` - ${problem}`);
  }
  process.exit(1);
}

console.log('Extraction freeze check passed (core KPI budgets healthy; new extractions allowed).');
