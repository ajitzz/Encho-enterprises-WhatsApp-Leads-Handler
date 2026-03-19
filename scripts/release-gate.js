#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
};

const assertRollbackRto = () => {
  const evidencePath = path.resolve(__dirname, '..', 'docs/release-evidence/rollback-drill-2026-03-15.md');
  if (!fs.existsSync(evidencePath)) {
    console.error('Release gate failed: missing rollback drill evidence.');
    process.exit(1);
  }

  const evidence = fs.readFileSync(evidencePath, 'utf8');
  const match = evidence.match(/within\s+(\d+)\s+minutes/i);
  if (!match) {
    console.error('Release gate failed: rollback evidence must include explicit recovery minutes.');
    process.exit(1);
  }

  const minutes = Number.parseInt(match[1], 10);
  if (!Number.isFinite(minutes) || minutes > 15) {
    console.error(`Release gate failed: rollback recovery ${minutes}m exceeds <=15m objective.`);
    process.exit(1);
  }
};

run('npm', ['run', 'check:boundaries']);
run('npm', ['run', 'check:contracts']);
run('npm', ['run', 'check:migration-evidence']);
run('npm', ['run', 'check:canary-perf']);
run('npm', ['run', 'check:section1-hardening']);
run('npm', ['run', 'check:rollout-modes']);
run('npm', ['run', 'check:industrial-readiness']);
run('npm', ['run', 'check:sections-1-3']);
run('npm', ['run', 'test:smoke']);
run('npm', ['run', 'test:rollback']);
run('npm', ['run', 'check:sections-4-7']);
run('npm', ['run', 'test:governance']);
run('npm', ['run', 'test:critical']);
assertRollbackRto();

console.log('\nRelease gate passed: governance, critical, smoke, rollback, section controls, and <=15m rollback evidence are green.');
