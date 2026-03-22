#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const problems = [];
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const flags = read('backend/shared/infra/flags.js');
for (const signal of ["mode === 'off'", "mode === 'shadow'", "mode === 'canary'", "mode === 'on' || mode === 'full'"]) {
  if (!flags.includes(signal)) problems.push(`flags.js missing rollout mode handling: ${signal}`);
}

const evidencePath = path.join(root, 'docs/release-evidence/canary-rollout-stages-2026-03-15.md');
if (!fs.existsSync(evidencePath)) {
  problems.push('Missing canary rollout evidence doc: docs/release-evidence/canary-rollout-stages-2026-03-15.md');
} else {
  const evidence = fs.readFileSync(evidencePath, 'utf8');
  for (const token of ['Stage 0', 'Stage 1', 'Stage 2', 'Stage 3', 'threshold', 'rollback']) {
    if (!evidence.toLowerCase().includes(token.toLowerCase())) {
      problems.push(`canary rollout evidence missing token: ${token}`);
    }
  }
}

if (problems.length) {
  console.error('Rollout mode check failed:');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}

console.log('Rollout mode check passed (legacy/shadow/canary/full controls and staged evidence are present).');
