#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const evidenceFiles = [
  'docs/release-evidence/pr-3.md',
  'docs/release-evidence/pr-5.md',
];

const MAX_P95_REGRESSION = 5;
const MAX_5XX_RATE = 0.05;
const MIN_SUCCESS_RATE = 98.5;
const MAX_ROLLBACK_RECOVERY_MINUTES = 15;

const problems = [];

for (const relFile of evidenceFiles) {
  const fullPath = path.join(root, relFile);
  if (!fs.existsSync(fullPath)) {
    problems.push(`Missing canary evidence file: ${relFile}`);
    continue;
  }

  const body = fs.readFileSync(fullPath, 'utf8');
  const windows = body.match(/\*\*Window\s*\d+\*\*/gi) || [];
  if (windows.length < 3) {
    problems.push(`${relFile} requires at least 3 canary windows for longitudinal confidence`);
  }

  if (!/peak\s*(traffic|hour)/i.test(body)) {
    problems.push(`${relFile} must include at least one peak traffic/hour canary window`);
  }

  for (const match of body.matchAll(/p95\s+latency\s+delta\s*:\s*\*\*([+-]?\d+(?:\.\d+)?)%\*\*/gi)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > MAX_P95_REGRESSION) {
      problems.push(`${relFile} exceeds p95 regression budget (+${MAX_P95_REGRESSION}%) with ${value}%`);
    }
  }

  for (const match of body.matchAll(/5xx\s+error\s+rate\s*:\s*\*\*([+-]?\d+(?:\.\d+)?)%\*\*/gi)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > MAX_5XX_RATE) {
      problems.push(`${relFile} exceeds 5xx error budget (${MAX_5XX_RATE}%) with ${value}%`);
    }
  }

  for (const match of body.matchAll(/(ingest\s+success\s+rate|reminder\s+dispatch\s+success)\s*:\s*\*\*([+-]?\d+(?:\.\d+)?)%\*\*/gi)) {
    const value = Number.parseFloat(match[2]);
    if (Number.isFinite(value) && value < MIN_SUCCESS_RATE) {
      problems.push(`${relFile} has success metric below ${MIN_SUCCESS_RATE}% (${match[1]}=${value}%)`);
    }
  }

  const rollbackMatch = body.match(/baseline latency normalized within\s+(\d+)\s+minutes|returned to baseline in\s+(\d+)\s+minutes/i);
  if (!rollbackMatch) {
    problems.push(`${relFile} is missing rollback recovery time evidence`);
  } else {
    const raw = rollbackMatch[1] || rollbackMatch[2];
    const minutes = Number.parseInt(raw, 10);
    if (!Number.isFinite(minutes) || minutes > MAX_ROLLBACK_RECOVERY_MINUTES) {
      problems.push(`${relFile} rollback recovery time exceeds ${MAX_ROLLBACK_RECOVERY_MINUTES} minutes (${raw})`);
    }
  }
}

if (problems.length > 0) {
  console.error('Performance canary gate failed:');
  for (const problem of problems) {
    console.error(` - ${problem}`);
  }
  process.exit(1);
}

console.log('Performance canary gate passed (latency/error/success budgets within SLO thresholds).');
