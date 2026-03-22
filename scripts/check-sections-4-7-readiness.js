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

const assertRecentEvidence = (relPath, maxAgeDays) => {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath)) return;

  const stats = fs.statSync(fullPath);
  const ageMs = Date.now() - stats.mtimeMs;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > maxAgeDays) {
    problems.push(`${relPath} is stale (${ageDays.toFixed(1)} days old, max ${maxAgeDays} days)`);
  }
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

const testMatrix = read('docs/operations/section-4-test-matrix.md');
for (const heading of [
  '## Unit tests',
  '## Integration tests',
  '## Smoke tests',
  '## Rollback validation',
]) {
  if (testMatrix && !testMatrix.includes(heading)) {
    problems.push(`section-4-test-matrix.md missing heading: ${heading}`);
  }
}

const rollbackDrill = read('docs/release-evidence/rollback-drill-2026-03-15.md');
for (const signal of [
  'FF_REMINDERS_MODULE=off',
  'FF_LEAD_INGESTION_MODULE=off',
  'recovered within',
  'smoke checks passed',
]) {
  if (rollbackDrill && !rollbackDrill.toLowerCase().includes(signal.toLowerCase())) {
    problems.push(`Rollback drill evidence missing signal: ${signal}`);
  }
}

const riskRegister = read('docs/operations/risk-register-status.md');
for (const signal of [
  '## Top risks operational status',
  'Owner',
  'Mitigation status',
  'Next review',
]) {
  if (riskRegister && !riskRegister.includes(signal)) {
    problems.push(`risk-register-status.md missing signal: ${signal}`);
  }
}

const scorecard = read('docs/operations/success-scorecard-latest.md');
for (const metric of [
  'webhook latency p95',
  'lead ingestion success rate',
  'reminder dispatch success',
  'queue lag',
  'MTTR',
]) {
  if (scorecard && !scorecard.toLowerCase().includes(metric.toLowerCase())) {
    problems.push(`success-scorecard-latest.md missing metric: ${metric}`);
  }
}

if (scorecard) {
  const ratingMatches = Array.from(scorecard.matchAll(/\*\*Section\s*[4-7]\s*rating:\s*([0-9]+(?:\.[0-9]+)?)\/10\*\*/gi));
  if (ratingMatches.length < 4) {
    problems.push('success-scorecard-latest.md must publish ratings for Sections 4, 5, 6, and 7');
  } else {
    for (const match of ratingMatches) {
      const rating = Number.parseFloat(match[1]);
      if (!Number.isFinite(rating) || rating < 9.9) {
        problems.push(`Sections 4-7 must be held at 9.9+/10; found ${match[0]}`);
      }
    }
  }

  const percentDelta = (name, maxAllowed) => {
    const regex = new RegExp(`${name}:[^\n]*?([+-]?\\d+(?:\\.\\d+)?)%`, 'i');
    const match = scorecard.match(regex);
    if (!match) {
      problems.push(`success-scorecard-latest.md missing percent delta for ${name}`);
      return;
    }

    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value) || value > maxAllowed) {
      problems.push(`${name} exceeds budget (${value}% > ${maxAllowed}%)`);
    }
  };

  const rateFloor = (name, minAllowed) => {
    const regex = new RegExp(`${name}:[^\n]*?(\\d+(?:\\.\\d+)?)%`, 'i');
    const match = scorecard.match(regex);
    if (!match) {
      problems.push(`success-scorecard-latest.md missing rate for ${name}`);
      return;
    }

    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value) || value < minAllowed) {
      problems.push(`${name} below production floor (${value}% < ${minAllowed}%)`);
    }
  };

  percentDelta('webhook latency p95', 5);
  percentDelta('webhook latency p99', 8);
  rateFloor('lead ingestion success rate', 99);
  rateFloor('reminder dispatch success', 99);
}

assertRecentEvidence('docs/operations/success-scorecard-latest.md', 14);
assertRecentEvidence('docs/operations/risk-register-status.md', 14);
assertRecentEvidence('docs/release-evidence/rollback-drill-2026-03-15.md', 30);

if (problems.length > 0) {
  console.error('Sections 4-7 readiness check failed:');
  for (const problem of problems) {
    console.error(` - ${problem}`);
  }
  process.exit(1);
}

console.log('Sections 4-7 readiness check passed (test/release/risk/scorecard controls are production-ready).');
