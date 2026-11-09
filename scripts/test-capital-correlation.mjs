import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { spawnSync } = await import('node:child_process');
const { readFileSync } = await import('node:fs');
const source = readFileSync(new URL('./correlate-capital-behavior.mjs', import.meta.url), 'utf8');
if (!source.includes("if (process.env.TIDE_CAPITAL_CORRELATION_TEST === '1') test();")) {
  throw new Error('Correlation test mode guard missing');
}
const run = spawnSync(process.execPath, ['--check', new URL('./correlate-capital-behavior.mjs', import.meta.url).pathname], { encoding: 'utf8' });
if (run.status !== 0) throw new Error(run.stderr || 'Correlation script syntax check failed');
console.log('Capital correlation script syntax test passed.');
