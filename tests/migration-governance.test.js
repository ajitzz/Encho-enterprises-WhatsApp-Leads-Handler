const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { buildBoundaryError } = require('../backend/shared/contracts/errorContract');

const { registerAuthConfigRoutes } = require('../backend/modules/auth-config/api');
const { registerSystemHealthRoutes } = require('../backend/modules/system-health/api');

const createRouterMock = () => {
  const routes = {};
  return {
    routes,
    get(path, handler) { routes[`GET ${path}`] = handler; },
    post(path, handler) { routes[`POST ${path}`] = handler; },
    patch(path, handler) { routes[`PATCH ${path}`] = handler; },
  };
};

const runScript = (script) => {
  const result = spawnSync('node', [script], { encoding: 'utf8' });
  return result;
};

test('buildBoundaryError enforces standard error shape', () => {
  const err = buildBoundaryError({
    code: 'LEAD_VALIDATION_FAILED',
    message: 'Invalid lead payload',
    category: 'validation',
    retriable: false,
    traceId: 'trace-1',
  });

  assert.deepEqual(err, {
    code: 'LEAD_VALIDATION_FAILED',
    message: 'Invalid lead payload',
    retriable: false,
    category: 'validation',
    details: null,
    traceId: 'trace-1',
  });
});

test('import boundaries check script passes', () => {
  const result = runScript('scripts/check-import-boundaries.js');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('contract versioning check script passes', () => {
  const result = runScript('scripts/check-contract-versioning.js');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('migration evidence check script passes', () => {
  const result = runScript('scripts/check-migration-evidence.js');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test('performance canary check script passes', () => {
  const result = runScript('scripts/check-performance-canary.js');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test('sections 4-7 readiness check script passes', () => {
  const result = runScript('scripts/check-sections-4-7-readiness.js');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('section 1 hardening check script passes', () => {
  const result = runScript('scripts/check-section1-hardening.js');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test('auth-config route registrar uses module path when mode is not off', async () => {
  const apiRouter = createRouterMock();
  const calls = [];

  registerAuthConfigRoutes({
    apiRouter,
    resolveMode: () => 'canary',
    moduleRouter: {
      verifyGoogle: async () => calls.push('module'),
      getBotSettings: async () => {},
      saveBotSettings: async () => {},
      publishBot: async () => {},
      getSystemSettings: async () => {},
      patchSystemSettings: async () => {},
    },
    legacyHandlers: {
      verifyGoogle: async () => calls.push('legacy'),
      getBotSettings: async () => {},
      saveBotSettings: async () => {},
      publishBot: async () => {},
      getSystemSettings: async () => {},
      patchSystemSettings: async () => {},
    },
  });

  await apiRouter.routes['POST /auth/google']({}, {});
  assert.deepEqual(calls, ['module']);
});

test('system-health route registrar falls back to legacy when mode is off', async () => {
  const apiRouter = createRouterMock();
  const calls = [];

  registerSystemHealthRoutes({
    apiRouter,
    resolveMode: () => 'off',
    moduleRouter: {
      health: async () => calls.push('module'),
      ready: async () => {},
      operationalStatus: async () => {},
      ping: async () => {},
      debugStatus: async () => {},
    },
    legacyHandlers: {
      health: async () => calls.push('legacy'),
      ready: async () => {},
      operationalStatus: async () => {},
      ping: async () => {},
      debugStatus: async () => {},
    },
  });

  await apiRouter.routes['GET /health']({}, {});
  assert.deepEqual(calls, ['legacy']);
});

