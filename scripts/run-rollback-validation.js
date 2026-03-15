#!/usr/bin/env node
const assert = require('node:assert/strict');
const { resolveModuleMode, parseBooleanFlag, parsePercent } = require('../backend/shared/infra/flags');

assert.equal(parseBooleanFlag('on', false), true);
assert.equal(parseBooleanFlag('off', true), false);
assert.equal(parseBooleanFlag('', true), true);
assert.equal(parsePercent('15', 0), 15);
assert.equal(parsePercent('999', 0), 100);
assert.equal(parsePercent('-1', 20), 0);

const offMode = resolveModuleMode({
  flagValue: 'off',
  tenantId: 'tenant-a',
  requestId: 'rollback-1',
  canaryPercent: 100,
  tenantAllowList: ['tenant-a'],
});
assert.equal(offMode, 'off');

const canaryTenant = resolveModuleMode({
  flagValue: 'canary',
  tenantId: 'tenant-a',
  requestId: 'rollback-2',
  canaryPercent: 0,
  tenantAllowList: ['tenant-a'],
});
assert.equal(canaryTenant, 'canary');

const canaryByPercent = resolveModuleMode({
  flagValue: 'canary',
  tenantId: 'tenant-z',
  requestId: 'A',
  canaryPercent: 100,
  tenantAllowList: [],
});
assert.equal(canaryByPercent, 'canary');

const canaryNonTenant = resolveModuleMode({
  flagValue: 'canary',
  tenantId: 'tenant-b',
  requestId: 'rollback-3',
  canaryPercent: 0,
  tenantAllowList: ['tenant-a'],
});
assert.equal(canaryNonTenant, 'off');

console.log('Rollback validation passed (flag parsing and scoped module routing are production-safe).');
