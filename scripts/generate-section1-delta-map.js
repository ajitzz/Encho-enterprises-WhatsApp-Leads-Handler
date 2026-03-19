#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const outputPath = path.join(root, 'docs/architecture/section1-delta-map.md');

const source = fs.readFileSync(serverPath, 'utf8');
const directRoutes = source.match(/apiRouter\.(get|post|patch|delete)\('/g) || [];
const moduleRegistrars = Array.from(source.matchAll(/register([A-Za-z]+)Routes\(/g)).map((match) => match[1]);

const directByFamily = {
  media: (source.match(/apiRouter\.(get|post|patch|delete)\('\/media/g) || []).length,
  webhook: (source.match(/apiRouter\.(get|post|patch|delete)\('\/webhook/g) || []).length,
  drivers: (source.match(/apiRouter\.(get|post|patch|delete)\('\/drivers/g) || []).length,
  reporting: (source.match(/apiRouter\.(get|post|patch|delete)\('\/reports/g) || []).length,
  reminders: (source.match(/apiRouter\.(get|post|patch|delete)\('\/(scheduled-messages|cron)/g) || []).length,
};

const lines = [
  '# Section 1 Delta Map (Current -> Target)',
  '',
  '## Target state reference',
  'Target architecture is defined in `docs/modular-monolith-migration-plan.md` Section 1 (bootstrap-only app server and module-isolated domain logic).',
  '',
  '## Current objective baseline (auto-generated)',
  `- Direct route handlers still declared in \`server.js\`: **${directRoutes.length}**.`,
  `- Module route registrars wired in \`server.js\`: **${moduleRegistrars.length}** (${moduleRegistrars.join(', ') || 'none'}).`,
  `- Family breakdown still on direct path: media=${directByFamily.media}, webhook=${directByFamily.webhook}, drivers=${directByFamily.drivers}, reporting=${directByFamily.reporting}, reminders=${directByFamily.reminders}.`,
  '',
  '## Current deltas',
  '1. `server.js` still carries direct route handlers for media/reporting/driver workspace and reminder route orchestration.',
  '2. `backend/app/server.js` is bootstrap-only and delegates startup to root server runtime for compatibility.',
  '3. Auth and system health route families are module-registered with default-safe mode resolution.',
  '',
  '## Migration slices (low blast radius)',
  '- Slice A: Extract agent-workspace route handlers to `backend/modules/agent-workspace/api.js` and keep legacy path behind mode `off`.',
  '- Slice B: Extract reporting-export routes to module API + service + adapters under `FF_REPORTING_EXPORT_MODULE` default `off`.',
  '- Slice C: Extract media routes to module API + service + adapters under `FF_MEDIA_MODULE` default `off`.',
  '- Slice D: Extract lead-lifecycle and campaign-broadcast route families under independent module flags.',
  '- Slice E: Finalize root `server.js` to bootstrap + middleware + mount wiring only.',
  '',
  '## Exit criteria',
  '- Root server file contains bootstrap + middleware + mount wiring only.',
  '- No direct DB/provider business logic in route handlers.',
  '- CI boundary checks and critical integration suite remain green.',
  '',
  '## Rollback path',
  '- Keep extracted module paths gated by default-safe feature flags and retain legacy handlers until parity logs remain within canary thresholds for two consecutive release windows.',
];

fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
console.log(`Updated ${path.relative(root, outputPath)} with current extraction baseline.`);
