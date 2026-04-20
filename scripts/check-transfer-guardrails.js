#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();

const checks = [
  {
    file: 'backend/modules/lead-ingestion/adapters/candidateRepo.js',
    forbidden: [/RETURNING\s+\*/i],
    message: 'Avoid RETURNING * on webhook hot path; return only required columns.',
  },
  {
    file: 'backend/modules/lead-ingestion/service.js',
    forbidden: [/SELECT\s+s\.id,\s*s\.name,\s*s\.email/i],
    message: 'Do not fetch staff email in auto distribution query when it is not used.',
  },
  {
    file: 'backend/modules/lead-ingestion/service.js',
    forbidden: [/SELECT\s+\*/i],
    message: 'Avoid SELECT * in lead ingestion hot path to reduce transfer overhead.',
  },
];

let failed = false;

for (const check of checks) {
  const fullPath = path.join(ROOT, check.file);
  const content = fs.readFileSync(fullPath, 'utf8');

  for (const pattern of check.forbidden) {
    if (pattern.test(content)) {
      failed = true;
      console.error(`❌ ${check.file}: ${check.message} (pattern: ${pattern})`);
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log('✅ Transfer guardrails passed for lead ingestion hot path.');
