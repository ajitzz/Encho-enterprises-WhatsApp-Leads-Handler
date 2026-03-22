#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.resolve(__dirname, '..');
const problems = [];
const requiredDocs = [
  'docs/architecture/section1-delta-map.md',
  'docs/adr/ADR-0001-modular-boundaries.md',
  'docs/operations/escalation-runbook.md',
  'docs/release-evidence/rollback-playbook-modules.md',
];

for (const rel of requiredDocs) {
  if (!fs.existsSync(path.join(root, rel))) problems.push(`Missing required industrial-readiness doc: ${rel}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'),'utf8'));
for (const scriptName of ['check:rollout-modes','check:industrial-readiness']) {
  if (!pkg.scripts?.[scriptName]) problems.push(`package.json missing script: ${scriptName}`);
}

if (problems.length) {
  console.error('Industrial readiness check failed:');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}

console.log('Industrial readiness check passed (delta map, ADR, escalation, rollback playbook are versioned).');
