#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');

const contractFiles = [
  'backend/shared/contracts/internalEvents.js',
  'backend/modules/lead-ingestion/contracts.js',
  'backend/modules/reminders-escalations/contracts.js',
  'backend/modules/lead-lifecycle/contracts.js',
  'backend/modules/reporting-export/contracts.js',
  'backend/modules/media/contracts.js',
  'backend/modules/bot-conversation/contracts.js',
  'backend/modules/agent-workspace/contracts.js',
  'backend/modules/campaign-broadcast/contracts.js',
  'backend/modules/system-health/contracts.js',
  'backend/modules/auth-config/contracts.js',
];

const changelogPath = path.join(repoRoot, 'docs', 'contracts-changelog.md');

const missingSchemaVersion = [];
for (const relPath of contractFiles) {
  const fullPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Missing contract file: ${relPath}`);
    process.exit(1);
  }
  const source = fs.readFileSync(fullPath, 'utf8');
  if (!source.includes('schemaVersion') && !source.includes('SCHEMA_VERSION')) {
    missingSchemaVersion.push(relPath);
  }
}

if (missingSchemaVersion.length > 0) {
  console.error('Contracts missing schemaVersion markers:');
  for (const relPath of missingSchemaVersion) {
    console.error(` - ${relPath}`);
  }
  process.exit(1);
}

if (!fs.existsSync(changelogPath)) {
  console.error('Missing docs/contracts-changelog.md');
  process.exit(1);
}

const changelog = fs.readFileSync(changelogPath, 'utf8');
const internalEvents = fs.readFileSync(path.join(repoRoot, 'backend/shared/contracts/internalEvents.js'), 'utf8');
const schemaVersionMatch = internalEvents.match(/SCHEMA_VERSION\s*=\s*['"]([0-9]+\.[0-9]+\.[0-9]+)['"]/);

if (!schemaVersionMatch) {
  console.error('Could not detect SCHEMA_VERSION in internal events contract file.');
  process.exit(1);
}

const currentVersion = schemaVersionMatch[1];
if (!changelog.includes(currentVersion)) {
  console.error(`contracts-changelog.md does not mention current schema version ${currentVersion}`);
  process.exit(1);
}

console.log(`Contract versioning check passed (current schema version ${currentVersion}).`);
