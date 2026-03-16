#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
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
run('npm', ['run', 'check:extraction-freeze']);
run('npm', ['run', 'test:governance']);
run('npm', ['run', 'test:critical']);
console.log('\nRelease gate passed: governance, critical, smoke, rollback, section 1 hardening, and sections 4-7 readiness checks are green and extraction freeze controls are healthy.');
