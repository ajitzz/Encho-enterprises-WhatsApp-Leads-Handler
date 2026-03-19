#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const historyPath = path.join(root, 'docs/operations/scorecard-history.json');
const outputPath = path.join(root, 'docs/operations/scorecard-trends-latest.md');

if (!fs.existsSync(historyPath)) {
  throw new Error('Missing docs/operations/scorecard-history.json');
}

const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
const latest = history[history.length - 1];

const checkpoints = [30, 60, 90].map((days) => {
  const cut = history.filter((entry) => entry.daysAgo <= days);
  const avg = (field) => (cut.reduce((sum, item) => sum + item[field], 0) / cut.length).toFixed(2);
  return {
    days,
    section4: avg('section4'),
    section5: avg('section5'),
    section6: avg('section6'),
    section7: avg('section7'),
  };
});

const markdown = [
  '# Scorecard Trends (Latest)',
  '',
  `Latest release: **${latest.release}**`,
  '',
  '## 30/60/90 checkpoint validation',
  '| Checkpoint | Section 4 | Section 5 | Section 6 | Section 7 |',
  '|---|---:|---:|---:|---:|',
  ...checkpoints.map((cp) => `| ${cp.days}d | ${cp.section4} | ${cp.section5} | ${cp.section6} | ${cp.section7} |`),
  '',
  '## Trend guardrail',
  '- All checkpoint averages must remain >= 9.9 to hold industrial 9.9 posture.',
].join('\n');

fs.writeFileSync(outputPath, `${markdown}\n`);
console.log(`Generated ${path.relative(root, outputPath)}`);
