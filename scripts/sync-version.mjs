#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;

const files = [
  {
    path: 'README.md',
    pattern: /dbmlx-[\d.]+\.vsix/g,
    replacement: `dbmlx-${version}.vsix`,
  },
  {
    path: 'llms.txt',
    pattern: /^(Version:\s*)[\d.]+/m,
    replacement: `$1${version}`,
  },
];

for (const { path, pattern, replacement } of files) {
  const original = readFileSync(path, 'utf8');
  const updated = original.replace(pattern, replacement);
  if (updated !== original) {
    writeFileSync(path, updated);
    console.log(`Updated ${path} → v${version}`);
  } else {
    console.log(`${path} already up to date`);
  }
}
