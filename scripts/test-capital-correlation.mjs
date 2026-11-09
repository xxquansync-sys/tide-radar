import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./correlate-capital-behavior.mjs', import.meta.url));
const result = spawnSync(process.execPath, [script], {
  encoding: 'utf8',
  env: { ...process.env, TIDE_CAPITAL_CORRELATION_TEST: '1' }
});
if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Capital correlation tests failed');
process.stdout.write(result.stdout);
