const normalize = (value, fallback = '') => String(value ?? fallback).trim().toLowerCase();

export const parseBooleanFlag = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = normalize(value);
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  return defaultValue;
};

export const parsePercent = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(0, Math.min(100, parsed));
};

const isCanaryTenant = (tenantId, allowList = []) => {
  if (!tenantId) return false;
  return allowList.includes(String(tenantId));
};

const isCanaryPercentHit = (seed, percent) => {
  if (!seed || percent <= 0) return false;
  const hash = Array.from(String(seed)).reduce((acc, char) => ((acc * 31) + char.charCodeAt(0)) % 100, 0);
  return hash < percent;
};

/**
 * @param {Object} [params]
 * @param {string} [params.flagValue]
 * @param {string | null} [params.tenantId]
 * @param {string | null} [params.requestId]
 * @param {number} [params.canaryPercent]
 * @param {any[]} [params.tenantAllowList]
 * @returns {'off' | 'on' | 'shadow' | 'canary'}
 */
export const resolveModuleMode = ({ flagValue = 'off', tenantId, requestId, canaryPercent = 0, tenantAllowList = [] } = {}) => {
  const mode = normalize(flagValue, 'off');
  if (mode === 'off') return 'off';
  if (mode === 'on' || mode === 'full') return 'on';
  if (mode === 'shadow') return 'shadow';
  if (mode === 'canary') {
    if (isCanaryTenant(tenantId, tenantAllowList)) return 'canary';
    if (isCanaryPercentHit(requestId || tenantId, canaryPercent)) return 'canary';
    return 'off';
  }
  return 'off';
};

export default {
  parseBooleanFlag,
  parsePercent,
  resolveModuleMode,
};
