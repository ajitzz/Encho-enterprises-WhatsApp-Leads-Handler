#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const problems = [];

const read = (relPath) => fs.readFileSync(path.join(root, relPath), 'utf8');

const serverJs = read('server.js');

const requiredSignals = [
  'registerSystemHealthRoutes({',
  'registerAuthConfigRoutes({',
  'const resolveSystemHealthMode = (req)',
  'const resolveAuthConfigMode = (req)',
];

for (const signal of requiredSignals) {
  if (!serverJs.includes(signal)) {
    problems.push(`server.js missing section-1 hardening signal: ${signal}`);
  }
}

const forbiddenDirectRoutePatterns = [
  "apiRouter.get('/health'",
  "apiRouter.get('/ready'",
  "apiRouter.get('/ping'",
  "apiRouter.get('/debug/status'",
  "apiRouter.post('/auth/google'",
  "apiRouter.get('/bot/settings'",
  "apiRouter.post('/bot/save'",
  "apiRouter.post('/bot/publish'",
];

for (const pattern of forbiddenDirectRoutePatterns) {
  if (serverJs.includes(pattern)) {
    problems.push(`server.js still declares direct route that should be module-registered: ${pattern}`);
  }
}

const appServer = read('backend/app/server.js');
for (const bootstrapSignal of ['startServer', 'require']) {
  if (!appServer.includes(bootstrapSignal)) {
    problems.push(`backend/app/server.js must remain bootstrap-only and include ${bootstrapSignal}`);
  }
}
if (appServer.includes('apiRouter.') || appServer.includes('app.get(')) {
  problems.push('backend/app/server.js should not declare route handlers directly');
}

const authApi = read('backend/modules/auth-config/api.js');
if (!authApi.includes('registerAuthConfigRoutes')) {
  problems.push('backend/modules/auth-config/api.js must export registerAuthConfigRoutes');
}

const healthApi = read('backend/modules/system-health/api.js');
if (!healthApi.includes('registerSystemHealthRoutes')) {
  problems.push('backend/modules/system-health/api.js must export registerSystemHealthRoutes');
}

const deltaMapPath = path.join(root, 'docs/architecture/section1-delta-map.md');
if (!fs.existsSync(deltaMapPath)) {
  problems.push('docs/architecture/section1-delta-map.md is required');
} else {
  const deltaMap = fs.readFileSync(deltaMapPath, 'utf8');
  for (const signal of ['Current objective baseline (auto-generated)', 'Rollback path']) {
    if (!deltaMap.includes(signal)) {
      problems.push(`section1 delta map is missing signal: ${signal}`);
    }
  }
}

if (problems.length > 0) {
  console.error('Section 1 hardening check failed:');
  for (const problem of problems) {
    console.error(` - ${problem}`);
  }
  process.exit(1);
}

console.log('Section 1 hardening check passed (bootstrap-only app entry + module-registered health/auth + delta map evidence).');
