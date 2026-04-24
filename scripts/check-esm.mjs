import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const ignoredDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
]);
const checkedExts = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '.cts']);
const forbiddenExts = new Set(['.cjs', '.cts']);
const self = 'scripts/check-esm.mjs';
const cjsDirToken = `__${'dirname'}`;
const cjsFileToken = `__${'filename'}`;

const rules = [
  { id: 'commonjs-require', pattern: /\brequire\s*\(/ },
  { id: 'commonjs-module-exports', pattern: /\bmodule\.exports\b/ },
  { id: 'commonjs-exports', pattern: /\bexports\.[A-Za-z_$]/ },
  { id: 'node-cjs-dirname', pattern: new RegExp(`\\b${cjsDirToken}\\b`) },
  { id: 'node-cjs-filename', pattern: new RegExp(`\\b${cjsFileToken}\\b`) },
  { id: 'bun-import-meta-dir', pattern: /import\.meta\.dir\b/ },
];

function extensionOf(path) {
  const match = path.match(/\.[^.]+$/);
  return match?.[0] ?? '';
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        yield* walk(join(dir, entry.name));
      }
      continue;
    }
    yield join(dir, entry.name);
  }
}

const violations = [];

for await (const file of walk(root)) {
  const rel = relative(root, file);
  if (rel === self) continue;

  const ext = extensionOf(file);
  if (!checkedExts.has(ext)) continue;

  if (forbiddenExts.has(ext)) {
    violations.push({ file: rel, rule: 'commonjs-extension', line: 1 });
    continue;
  }

  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const rule of rules) {
    const idx = lines.findIndex((line) => rule.pattern.test(line));
    if (idx >= 0) {
      violations.push({ file: rel, rule: rule.id, line: idx + 1 });
    }
  }
}

if (violations.length > 0) {
  console.error('ESM check failed:');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} ${violation.rule}`);
  }
  process.exit(1);
}

console.log('ESM check passed');
