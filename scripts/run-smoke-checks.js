#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  if (!/register|router|route|export/i.test(body)) {
    failures.push(`No route registration signal found in ${relPath}`);
  }
}

if (failures.length > 0) {
  console.error('Smoke checks failed:');
  failures.forEach((entry) => console.error(` - ${entry}`));
  process.exit(1);
}

console.log('Smoke checks passed for health/webhook/media/reporting route surfaces.');
