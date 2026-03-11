#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
};

run('npm', ['run', 'test:critical']);
console.log('\nRelease gate passed: critical test suite is green.');
