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
const MAX_P99_REGRESSION = 8;
const MAX_QUEUE_LAG_DELTA_MS = 150;
const REQUIRED_WINDOWS = 4;
const REQUIRED_PEAK_WINDOWS = 2;
const MAX_EVIDENCE_STALENESS_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const today = new Date();

const problems = [];

const parseEvidenceDates = (body) => {
  const dates = [];
  for (const match of body.matchAll(/Date:\s*\*\*(\d{4}-\d{2}-\d{2})\*\*/gi)) {
    const parsed = new Date(`${match[1]}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      dates.push(parsed);
    }
  }
  return dates;
};

for (const relFile of evidenceFiles) {
  const fullPath = path.join(root, relFile);
  if (!fs.existsSync(fullPath)) {
    problems.push(`Missing canary evidence file: ${relFile}`);
    continue;
  }

  const body = fs.readFileSync(fullPath, 'utf8');
  const windows = body.match(/\*\*Window\s*\d+\*\*/gi) || [];
  if (windows.length < REQUIRED_WINDOWS) {
    problems.push(`${relFile} requires at least ${REQUIRED_WINDOWS} canary windows for recurring confidence`);
  }

  const peakWindows = body.match(/\*\*Window\s*\d+\*\*[\s\S]*?(peak\s*(traffic|hour))/gi) || [];
  if (peakWindows.length < REQUIRED_PEAK_WINDOWS) {
    problems.push(`${relFile} must include at least ${REQUIRED_PEAK_WINDOWS} peak traffic/hour windows`);
  }

  const dates = parseEvidenceDates(body);
  if (dates.length === 0) {
    problems.push(`${relFile} must include parseable canary dates in YYYY-MM-DD format`);
  } else {
    const latestDate = new Date(Math.max(...dates.map((d) => d.getTime())));
    const ageDays = Math.floor((today.getTime() - latestDate.getTime()) / DAY_MS);
    if (ageDays > MAX_EVIDENCE_STALENESS_DAYS) {
      problems.push(`${relFile} latest canary evidence is stale (${ageDays} days old, max ${MAX_EVIDENCE_STALENESS_DAYS})`);
    }
  }

  for (const match of body.matchAll(/p95\s+latency\s+delta\s*:\s*\*\*([+-]?\d+(?:\.\d+)?)%\*\*/gi)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > MAX_P95_REGRESSION) {
      problems.push(`${relFile} exceeds p95 regression budget (+${MAX_P95_REGRESSION}%) with ${value}%`);
    }
  }

  for (const match of body.matchAll(/p99\s+latency\s+delta\s*:\s*\*\*([+-]?\d+(?:\.\d+)?)%\*\*/gi)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > MAX_P99_REGRESSION) {
      problems.push(`${relFile} exceeds p99 regression budget (+${MAX_P99_REGRESSION}%) with ${value}%`);
    }
  }

  if (!/p99\s+latency\s+delta\s*:/i.test(body)) {
    problems.push(`${relFile} must include p99 latency delta metrics for observability guardrails`);
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

  for (const match of body.matchAll(/queue\s+lag\s+delta\s*:\s*\*\*([+-]?\d+(?:\.\d+)?)ms\*\*/gi)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > MAX_QUEUE_LAG_DELTA_MS) {
      problems.push(`${relFile} exceeds queue lag regression budget (+${MAX_QUEUE_LAG_DELTA_MS}ms) with ${value}ms`);
    }
  }

  if (!/queue\s+lag\s+delta\s*:/i.test(body)) {
    problems.push(`${relFile} must include queue lag delta metrics for rollout safety`);
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

console.log('Performance canary gate passed (recurring evidence + observability budgets are within guardrails).');
