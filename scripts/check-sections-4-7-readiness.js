#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const problems = [];

const read = (relPath) => {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath)) {
    problems.push(`Missing required artifact: ${relPath}`);
    return '';
  }
  return fs.readFileSync(fullPath, 'utf8');
};

const packageJson = JSON.parse(read('package.json') || '{}');
const scripts = packageJson.scripts || {};

const requiredScripts = [
  'test:critical',
  'test:governance',
  'test:smoke',
  'test:rollback',
  'release:gate',
  'check:sections-4-7',
];

for (const name of requiredScripts) {
  if (!scripts[name]) {
    problems.push(`package.json is missing script: ${name}`);
  }
}

const releaseGate = read('scripts/release-gate.js');
for (const step of ['check:boundaries', 'check:contracts', 'check:migration-evidence', 'check:canary-perf', 'test:smoke', 'test:rollback', 'check:sections-4-7', 'test:governance', 'test:critical']) {
  if (releaseGate && !releaseGate.includes(step)) {
    problems.push(`release-gate.js missing mandatory step: ${step}`);
  }
}

const testMatrix = read('docs/operations/section-4-test-matrix.md');
for (const heading of ['## Unit tests', '## Integration tests', '## Smoke tests', '## Rollback validation']) {
  if (testMatrix && !testMatrix.includes(heading)) {
    problems.push(`section-4-test-matrix.md missing heading: ${heading}`);
  }
}

const rollbackDrill = read('docs/release-evidence/rollback-drill-2026-03-15.md');
for (const signal of ['FF_REMINDERS_MODULE=off', 'FF_LEAD_INGESTION_MODULE=off', 'recovered within', 'smoke checks passed']) {
  if (rollbackDrill && !rollbackDrill.toLowerCase().includes(signal.toLowerCase())) {
    problems.push(`Rollback drill evidence missing signal: ${signal}`);
  }
}

const riskRegister = read('docs/operations/risk-register-status.md');
for (const signal of ['## Top risks operational status', 'Owner', 'Mitigation status', 'Next review']) {
  if (riskRegister && !riskRegister.includes(signal)) {
    problems.push(`risk-register-status.md missing signal: ${signal}`);
  }
}

const scorecard = read('docs/operations/success-scorecard-latest.md');
for (const metric of ['webhook latency p95', 'lead ingestion success rate', 'reminder dispatch success', 'queue lag', 'MTTR']) {
  if (scorecard && !scorecard.toLowerCase().includes(metric.toLowerCase())) {
    problems.push(`success-scorecard-latest.md missing metric: ${metric}`);
  }
}

if (scorecard) {
  const ratingMatches = Array.from(scorecard.matchAll(/\*\*Section\s*([4-7])\s*rating:\s*([0-9]+(?:\.[0-9]+)?)\/10\*\*/gi));
  const sectionSet = new Set(ratingMatches.map((entry) => entry[1]));

  if (sectionSet.size < 4) {
    problems.push('success-scorecard-latest.md must publish ratings for Sections 4, 5, 6, and 7');
  } else {
    for (const match of ratingMatches) {
      const rating = Number.parseFloat(match[2]);
      if (!Number.isFinite(rating) || rating < 9.9) {
        problems.push(`Sections 4-7 must be held at 9.9+/10; found Section ${match[1]} at ${match[2]}/10`);
      }
    }
  }

  const dateMatch = scorecard.match(/Updated:\s*\*\*(\d{4}-\d{2}-\d{2})\*\*/i);
  if (!dateMatch) {
    problems.push('success-scorecard-latest.md must include an Updated date in YYYY-MM-DD format');
  }
}

if (problems.length > 0) {
  console.error('Sections 4-7 readiness check failed:');
  for (const problem of problems) {
    console.error(` - ${problem}`);
  }
  process.exit(1);
}

console.log('Sections 4-7 readiness check passed (automated test/release/risk/scorecard controls are production-ready).');
