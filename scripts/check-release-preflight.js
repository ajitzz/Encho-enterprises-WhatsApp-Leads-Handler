#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const checks = [
  ['npm', ['run', 'check:boundaries']],
  ['npm', ['run', 'check:contracts']],
  ['npm', ['run', 'check:sections-1-3']],
  ['npm', ['run', 'check:sections-4-7']],
  ['npm', ['run', 'check:canary-perf']],
  ['npm', ['run', 'test:governance']],
];

for (const [cmd, args] of checks) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log('Release preflight passed.');
