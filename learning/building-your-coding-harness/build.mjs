// Assembles src/head.html + src/parts/*.html (sorted) + src/tail.html → index.html
// Usage:
//   node build.mjs              → index.html (all parts)
//   node build.mjs --only 30    → .preview/30.html (only parts whose filename starts with "30")
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const src = join(dir, 'src');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

let parts = readdirSync(join(src, 'parts')).filter(f => f.endsWith('.html')).sort();
if (only) parts = parts.filter(f => f.startsWith(only));

const html = [
  readFileSync(join(src, 'head.html'), 'utf8'),
  ...parts.map(f => `\n<!-- ===== part: ${f} ===== -->\n` + readFileSync(join(src, 'parts', f), 'utf8')),
  readFileSync(join(src, 'tail.html'), 'utf8'),
].join('\n');

let out = join(dir, 'index.html');
if (only) { mkdirSync(join(dir, '.preview'), { recursive: true }); out = join(dir, '.preview', `${only}.html`); }
writeFileSync(out, html);
console.log(`${out} built from ${parts.length} parts: ${parts.join(', ')}`);
