#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requiredModules = [
  'backend/modules/system-health/api.js',
  'backend/modules/media/api.js',
  'backend/modules/lead-ingestion/api.js',
  'backend/modules/reporting-export/api.js',
];

const failures = [];
for (const relPath of requiredModules) {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath)) {
    failures.push(`Missing API smoke surface: ${relPath}`);
    continue;
  }
  const body = fs.readFileSync(fullPath, 'utf8');
  if (!/register|router|route|module\.exports/i.test(body)) {
    failures.push(`No route registration signal found in ${relPath}`);
  }
}

if (failures.length > 0) {
  console.error('Smoke checks failed:');
  failures.forEach((entry) => console.error(` - ${entry}`));
  process.exit(1);
}

console.log('Smoke checks passed for health/webhook/media/reporting route surfaces.');
