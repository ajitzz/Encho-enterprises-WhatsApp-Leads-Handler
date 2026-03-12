#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const requiredEvidenceFiles = [1, 2, 3, 4, 5].map((n) => `docs/release-evidence/pr-${n}.md`);
const requiredEvidenceSections = [
  '## Goal',
  '## Scope',
  '## Out-of-scope',
  '## Risk',
  '## Rollback proof',
  '## Metrics impact',
  '## Test evidence',
  '## Canary evidence',
  '## Post-release notes',
];

const modulesRoot = path.join(root, 'backend', 'modules');
const moduleNames = fs.readdirSync(modulesRoot).filter((entry) => {
  const full = path.join(modulesRoot, entry);
  return fs.statSync(full).isDirectory();
});

const problems = [];

for (const relPath of requiredEvidenceFiles) {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath)) {
    problems.push(`Missing release evidence file: ${relPath}`);
    continue;
  }
  const body = fs.readFileSync(fullPath, 'utf8');
  for (const section of requiredEvidenceSections) {
    if (!body.includes(section)) {
      problems.push(`${relPath} is missing section: ${section}`);
    }
  }

  if (/\bTBD\b/i.test(body)) {
    problems.push(`${relPath} still contains placeholder content (TBD)`);
  }
}

for (const moduleName of moduleNames) {
  const ownershipPath = path.join(modulesRoot, moduleName, 'OWNERSHIP.md');
  if (!fs.existsSync(ownershipPath)) {
    problems.push(`Missing module ownership metadata: backend/modules/${moduleName}/OWNERSHIP.md`);
  }
}

if (problems.length > 0) {
  console.error('Migration evidence check failed:');
  for (const problem of problems) {
    console.error(` - ${problem}`);
  }
  process.exit(1);
}

console.log('Migration evidence check passed (release evidence is complete and ownership metadata exists).');
