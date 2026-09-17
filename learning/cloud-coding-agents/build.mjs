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

const assembled = [
  readFileSync(join(src, 'head.html'), 'utf8'),
  ...parts.map(f => `\n<!-- ===== part: ${f} ===== -->\n` + readFileSync(join(src, 'parts', f), 'utf8')),
  readFileSync(join(src, 'tail.html'), 'utf8'),
].join('\n');

// Inline vendored SVGs: brand logos and Lucide icons work without runtime requests.
// Source markup: <i data-icon="lucide-cloud"></i>. Labels stay in adjacent text.
const icons = new Map();
const html = assembled.replace(/<i data-icon="([a-z0-9-]+)"><\/i>/g, (_, name) => {
  if (!icons.has(name)) {
    const source = readFileSync(join(src, 'icons', `${name}.svg`), 'utf8').trim();
    const compact = source
      .replace(/<!--[^]*?-->/g, '')
      .replace(/\r?\n\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!/<svg\b/.test(compact) || !compact.includes('viewBox=')) {
      throw new Error(`Invalid SVG icon: ${name}`);
    }
    const svg = compact.replace(/<svg\b([^>]*)>/, (_, attrs) =>
      `<svg${attrs.replace(/\s(?:width|height|class|aria-hidden|focusable)="[^"]*"/g, '')} class="icon" data-icon-name="${name}" aria-hidden="true" focusable="false">`);
    icons.set(name, svg);
  }
  return icons.get(name);
});
if (html.includes('data-icon="')) throw new Error('Unresolved icon placeholder');

let out = join(dir, 'index.html');
if (only) { mkdirSync(join(dir, '.preview'), { recursive: true }); out = join(dir, '.preview', `${only}.html`); }
writeFileSync(out, html);
console.log(`${out} built from ${parts.length} parts: ${parts.join(', ')}`);
