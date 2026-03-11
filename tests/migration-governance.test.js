const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { buildBoundaryError } = require('../backend/shared/contracts/errorContract');

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
