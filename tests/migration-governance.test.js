const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { buildBoundaryError } = require('../backend/shared/contracts/errorContract');
const { resolveModuleMode } = require('../backend/shared/infra/flags');

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

test('resolveModuleMode supports shadow and canary fallback semantics', () => {
  assert.equal(resolveModuleMode({ flagValue: 'shadow', tenantId: 't-1', requestId: 'r-1', canaryPercent: 0, tenantAllowList: [] }), 'shadow');
  assert.equal(resolveModuleMode({ flagValue: 'canary', tenantId: 'tenant-allowed', requestId: 'r-1', canaryPercent: 0, tenantAllowList: ['tenant-allowed'] }), 'canary');
  assert.equal(resolveModuleMode({ flagValue: 'canary', tenantId: 'tenant-denied', requestId: 'r-1', canaryPercent: 0, tenantAllowList: ['tenant-allowed'] }), 'off');
});

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

test('rollout mode check script passes', () => {
  const result = runScript('scripts/check-rollout-modes.js');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('industrial readiness check script passes', () => {
  const result = runScript('scripts/check-industrial-readiness.js');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('sections 1-3 readiness check script passes', () => {
  const result = runScript('scripts/check-sections-1-3-readiness.js');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test('legacy schema self-heal includes staff lead columns and undefined-column recovery', () => {
  const serverSource = require('node:fs').readFileSync('server.js', 'utf8');

  assert.match(serverSource, /ALTER TABLE candidates ADD COLUMN IF NOT EXISTS assigned_to UUID/);
  assert.match(serverSource, /ALTER TABLE candidates ADD COLUMN IF NOT EXISTS lead_status VARCHAR\(50\) DEFAULT 'new'/);
  assert.match(serverSource, /err\.code === '42P01' \|\| err\.code === '42703'/);
});

test('candidate staff portal indexes are present for pool and assignment queries', () => {
  const serverSource = require('node:fs').readFileSync('server.js', 'utf8');

  assert.match(serverSource, /CREATE INDEX IF NOT EXISTS idx_candidates_assigned_last_action_created/);
  assert.match(serverSource, /CREATE INDEX IF NOT EXISTS idx_candidates_pool_created_at/);
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

