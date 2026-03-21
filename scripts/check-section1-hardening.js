#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const problems = [];

const read = (relPath) => fs.readFileSync(path.join(root, relPath), 'utf8');

const serverJs = read('server.js');

const requiredSignals = [
  "registerSystemHealthRoutes({",
  "registerAuthConfigRoutes({",
  "const resolveSystemHealthMode = (req)",
  "const resolveAuthConfigMode = (req)",
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

const authApi = read('backend/modules/auth-config/api.js');
if (!authApi.includes('registerAuthConfigRoutes')) {
  problems.push('backend/modules/auth-config/api.js must export registerAuthConfigRoutes');
}

const healthApi = read('backend/modules/system-health/api.js');
if (!healthApi.includes('registerSystemHealthRoutes')) {
  problems.push('backend/modules/system-health/api.js must export registerSystemHealthRoutes');
}

if (problems.length > 0) {
  console.error('Section 1 hardening check failed:');
  for (const problem of problems) {
    console.error(` - ${problem}`);
  }
  process.exit(1);
}

console.log('Section 1 hardening check passed (auth-config and system-health route families are module-registered).');
