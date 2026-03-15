#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');

const requiredServerRoutes = [
  "apiRouter.get('/health'",
  "apiRouter.get('/ping'",
  "apiRouter.get('/debug/status'",
  "apiRouter.get('/webhook'",
  "apiRouter.post('/webhook'",
  "apiRouter.get('/media'",
  "apiRouter.post('/media/upload'",
  "apiRouter.delete('/media/files/:id'",
  "apiRouter.get('/reports/driver-excel'",
  "apiRouter.post('/reports/driver-excel/sync'",
];

const missingRoutes = requiredServerRoutes.filter((routeSignature) => !serverSource.includes(routeSignature));
if (missingRoutes.length) {
  console.error('Smoke checks failed: missing critical server route signatures');
  missingRoutes.forEach((sig) => console.error(` - ${sig}`));
  process.exit(1);
}

const moduleApiChecks = [
  {
    path: 'backend/modules/system-health/api.js',
    exportName: 'buildSystemHealthRouter',
  },
  {
    path: 'backend/modules/lead-ingestion/api.js',
    exportName: 'buildLeadIngestionFacade',
  },
  {
    path: 'backend/modules/media/api.js',
    exportName: 'register',
  },
  {
    path: 'backend/modules/reporting-export/api.js',
    exportName: 'register',
  },
];

for (const check of moduleApiChecks) {
  const absolutePath = path.join(root, check.path);
  if (!fs.existsSync(absolutePath)) {
    console.error(`Smoke checks failed: missing module api file ${check.path}`);
    process.exit(1);
  }

  const loaded = require(absolutePath);
  assert.equal(
    typeof loaded[check.exportName],
    'function',
    `${check.path} must export function ${check.exportName}`
  );
}

console.log('Smoke checks passed: critical route signatures and module API exports are valid.');
