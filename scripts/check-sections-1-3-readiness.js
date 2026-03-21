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

for (const name of [
  'check:boundaries',
  'check:contracts',
  'check:migration-evidence',
  'check:canary-perf',
  'check:section1-hardening',
  'check:sections-1-3',
]) {
  if (!scripts[name]) {
    problems.push(`package.json is missing script: ${name}`);
  }
}

const migrationPlan = read('docs/modular-monolith-migration-plan.md');
for (const heading of ['## 1) Architecture Diff Plan', '## 2) Module Contract Specs', '## 3) Migration PR Plan']) {
  if (migrationPlan && !migrationPlan.includes(heading)) {
    problems.push(`modular-monolith-migration-plan.md missing heading: ${heading}`);
  }
}

const sectionReadiness = read('docs/operations/sections-1-3-readiness-latest.md');
for (const signal of [
  '## Section ratings',
  'Section 1',
  'Section 2',
  'Section 3',
  '## Overall production decision',
]) {
  if (sectionReadiness && !sectionReadiness.includes(signal)) {
    problems.push(`sections-1-3-readiness-latest.md missing signal: ${signal}`);
  }
}

if (sectionReadiness) {
  const ratingMatches = Array.from(sectionReadiness.matchAll(/\*\*Section\s*[1-3]\s*rating:\s*([0-9]+(?:\.[0-9]+)?)\/10\*\*/gi));
  if (ratingMatches.length < 3) {
    problems.push('sections-1-3-readiness-latest.md must publish ratings for Sections 1, 2, and 3');
  } else {
    for (const match of ratingMatches) {
      const rating = Number.parseFloat(match[1]);
      if (!Number.isFinite(rating) || rating < 9.9) {
        problems.push(`Sections 1-3 must be held at 9.9+/10; found ${match[0]}`);
      }
    }
  }

  if (!/overall\s+rating:\s*\*\*9\.9\/10\*\*/i.test(sectionReadiness)) {
    problems.push('sections-1-3-readiness-latest.md must publish an overall rating of 9.9/10');
  }

  if (!/production-ready/i.test(sectionReadiness)) {
    problems.push('sections-1-3-readiness-latest.md must declare production-ready decision');
  }
}

const serverJs = read('server.js');
for (const signal of [
  'buildLeadIngestionFacade',
  "apiRouter.post('/webhook'",
  'buildRemindersRouter',
  "apiRouter.post('/scheduled-messages'",
  "apiRouter.get('/cron/process-queue'",
  'registerAuthConfigRoutes({',
  'registerSystemHealthRoutes({',
]) {
  if (serverJs && !serverJs.includes(signal)) {
    problems.push(`server.js missing Section 1-3 extraction signal: ${signal}`);
  }
}

for (const evidence of [
  'docs/release-evidence/pr-1.md',
  'docs/release-evidence/pr-2.md',
  'docs/release-evidence/pr-3.md',
  'docs/release-evidence/pr-4.md',
  'docs/release-evidence/pr-5.md',
  'docs/release-evidence/pr-6.md',
]) {
  if (!fs.existsSync(path.join(root, evidence))) {
    problems.push(`Missing migration evidence: ${evidence}`);
  }
}

assertRecentEvidence('docs/operations/sections-1-3-readiness-latest.md', 14);
assertRecentEvidence('docs/release-evidence/pr-6.md', 30);

if (problems.length > 0) {
  console.error('Sections 1-3 readiness check failed:');
  for (const problem of problems) {
    console.error(` - ${problem}`);
  }
  process.exit(1);
}

console.log('Sections 1-3 readiness check passed (architecture/contracts/migration controls are held at 9.9+ with current evidence).');
