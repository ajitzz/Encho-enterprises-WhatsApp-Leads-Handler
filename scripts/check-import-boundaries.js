#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');
const backendRoot = path.join(repoRoot, 'backend');
const modulesRoot = path.join(backendRoot, 'modules');
const sharedRoot = path.join(backendRoot, 'shared');

const SOURCE_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.mjs', '.cjs']);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractImports(source) {
  const imports = [];
  const regexes = [
    /require\((['"])([^'"]+)\1\)/g,
    /import\s+(?:[^'";]+\s+from\s+)?(['"])([^'"]+)\1/g,
    /import\((['"])([^'"]+)\1\)/g,
    /from\s+(['"])([^'"]+)\1/g,
  ];

  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      imports.push(match[2]);
    }
  }

  return imports;
}

function resolveImportPath(filePath, importPath) {
  if (!importPath.startsWith('.')) return null;
  const base = path.resolve(path.dirname(filePath), importPath);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || base;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function getModuleName(filePath) {
  const rel = toPosix(path.relative(modulesRoot, filePath));
  return rel.split('/')[0];
}

const violations = [];
const filesToCheck = [
  ...walk(modulesRoot),
  ...walk(sharedRoot),
  path.join(repoRoot, 'server.ts'),
];

for (const filePath of filesToCheck) {
  if (!fs.existsSync(filePath)) continue;
  const relFile = toPosix(path.relative(repoRoot, filePath));
  const source = fs.readFileSync(filePath, 'utf8');
  const imports = extractImports(source);

  for (const importPath of imports) {
    const resolved = resolveImportPath(filePath, importPath);
    const relImport = resolved ? toPosix(path.relative(repoRoot, resolved)) : importPath;

    // Rule 1: shared -> modules is forbidden
    if (relFile.startsWith('backend/shared/') && (relImport.startsWith('backend/modules/') || importPath.includes('/modules/'))) {
      violations.push(`${relFile} imports module path ${importPath}`);
    }

    // Rule 2: module adapter cannot import another module adapter directly
    const isAdapterFile = relFile.startsWith('backend/modules/') && relFile.includes('/adapters/');
    const isImportingModuleAdapter = relImport.startsWith('backend/modules/') && relImport.includes('/adapters/');

    if (isAdapterFile && isImportingModuleAdapter) {
      const importerModule = getModuleName(filePath);
      const importedModule = getModuleName(path.join(repoRoot, relImport));
      if (importerModule && importedModule && importerModule !== importedModule) {
        violations.push(`${relFile} imports adapter from another module: ${relImport}`);
      }
    }

    // Rule 3: app entrypoint must import module APIs only (not module services/adapters/contracts)
    if (relFile === 'server.ts' && relImport.startsWith('backend/modules/')) {
      const allowedSuffixes = ['/api.js', '/api.ts', '/api/index.js', '/api/index.ts'];
      const isApiImport = allowedSuffixes.some((suffix) => relImport.endsWith(suffix));
      if (!isApiImport) {
        violations.push(`server.ts imports non-api module path: ${relImport}`);
      }
    }

    // Rule 4: modules/shared cannot depend on server entrypoint
    const isModuleOrSharedFile = relFile.startsWith('backend/modules/') || relFile.startsWith('backend/shared/');
    if (isModuleOrSharedFile && (relImport === 'server.ts' || importPath === '../../server' || importPath === '../server' || importPath === '../../server.js' || importPath === '../server.js')) {
      violations.push(`${relFile} depends on server entrypoint via ${importPath}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Import boundary violations detected:');
  for (const violation of violations) {
    console.error(` - ${violation}`);
  }
  process.exit(1);
}

console.log('Import boundary check passed (app -> modules -> shared guardrails).');
