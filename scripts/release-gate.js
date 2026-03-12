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
run('npm', ['run', 'test:governance']);
run('npm', ['run', 'test:critical']);
console.log('\nRelease gate passed: governance + critical suites are green.');
