import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const blocks = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))
  .map(match => match[1].trim())
  .filter(Boolean);
if (!blocks.length) throw new Error('No inline JavaScript blocks found');
blocks.forEach((source, index) => new Script(source, { filename: 'index.html:inline-' + index }));
if (!html.includes('<script src="./scripts/momentum-exhaustion.js"></script>')) {
  throw new Error('Momentum exhaustion browser module is not loaded');
}
if (!html.includes('MACD:[13,34,9]')) throw new Error('Visible MACD default is not 13/34/9');
console.log('Index inline JavaScript syntax passed: ' + blocks.length + ' script blocks.');
