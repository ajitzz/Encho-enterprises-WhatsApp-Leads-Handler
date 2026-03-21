#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolveModuleMode } from '../backend/shared/infra/flags.js';

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

const canaryNonTenant = resolveModuleMode({
  flagValue: 'canary',
  tenantId: 'tenant-b',
  requestId: 'rollback-3',
  canaryPercent: 0,
  tenantAllowList: ['tenant-a'],
});
assert.equal(canaryNonTenant, 'off');

console.log('Rollback validation passed (off switch and scoped canary routing behave correctly).');
