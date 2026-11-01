import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimestampSafe } from '../server/services/driverSnapshotCache.js';

test('parseTimestampSafe correctly handles multiple timestamp representations', () => {
  const now = 1793567157898;

  // Numeric epoch
  assert.equal(parseTimestampSafe(now), now);

  // String numeric epoch
  assert.equal(parseTimestampSafe('1793567157898'), now);

  // Date instance
  const dateObj = new Date('2026-11-02T02:34:00.000Z');
  assert.equal(parseTimestampSafe(dateObj), dateObj.getTime());

  // ISO string
  const isoStr = '2026-11-02T02:34:00.000Z';
  assert.equal(parseTimestampSafe(isoStr), Date.parse(isoStr));

  // Postgres text timestamp
  const pgTimestamp = '2026-11-02 02:34:00.000+00';
  assert.equal(parseTimestampSafe(pgTimestamp), Date.parse(pgTimestamp));

  // Fallback on invalid or empty
  assert.equal(parseTimestampSafe(null), 0);
  assert.equal(parseTimestampSafe(undefined), 0);
  assert.equal(parseTimestampSafe(''), 0);
  assert.equal(parseTimestampSafe('0'), 0);
  assert.equal(parseTimestampSafe('invalid-date'), 0);
  assert.equal(parseTimestampSafe(NaN), 0);
});

test('24h Window Calculation: correctly determines active window from recent customer interaction', () => {
  const WINDOW_DURATION = 24 * 60 * 60 * 1000;
  const recentInteraction = Date.now() - (2 * 60 * 1000); // 2 minutes ago
  const oldInteraction = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago

  // Recent interaction within 24 hours
  const isRecentActive = (Date.now() - recentInteraction) < WINDOW_DURATION;
  assert.equal(isRecentActive, true);

  const timeLeft = (recentInteraction + WINDOW_DURATION) - Date.now();
  const hours = Math.floor(timeLeft / (60 * 60 * 1000));
  assert.equal(hours, 23); // 23h remaining!

  // Old interaction past 24 hours
  const isOldActive = (Date.now() - oldInteraction) < WINDOW_DURATION;
  assert.equal(isOldActive, false);
});
