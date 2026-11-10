import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const handler = require('../api/candle-flow.js');

async function invoke(fetchImpl) {
  globalThis.fetch = fetchImpl;
  const req = { method: 'GET', query: { symbol: 'BTC', start: '1700000000000', end: '1700000300000' } };
  const res = {
    statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(body) { this.body = body; }
  };
  await handler(req, res);
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}
const okPayload = data => ({ ok: true, async json() { return { code: '0', msg: '', data }; } });
const failPayload = () => ({ ok: false, status: 503, async json() { return { code: '500', msg: 'mock unavailable', data: [] }; } });

let calls = [];
let result = await invoke(async url => {
  calls.push(String(url));
  return okPayload(String(url).includes('open-interest-history')
    ? [['1700000000000','100','1','50000']]
    : [['1700000000000','12','15']]);
});
assert.equal(result.body.exchanges[0].ok, true);
assert.equal(result.body.exchanges[0].status, 'complete');
assert.equal(result.body.exchanges[0].campaign.oi.length, 1);
assert.equal(result.body.exchanges[0].campaign.taker.length, 1);
assert.equal(calls.length, 2);

result = await invoke(async url => String(url).includes('open-interest-history') ? okPayload([]) : failPayload());
assert.equal(result.body.exchanges[0].ok, true);
assert.equal(result.body.exchanges[0].status, 'partial');
assert.match(result.body.exchanges[0].campaign.takerError, /HTTP 503/);

result = await invoke(async () => failPayload());
assert.equal(result.body.exchanges[0].ok, false);
assert.equal(result.body.exchanges[0].status, 'unavailable');
assert.match(result.body.exchanges[0].error, /Both OKX aggregate series failed/);

result = await invoke(async () => okPayload([]));
assert.equal(result.body.exchanges[0].status, 'complete');
console.log('Candle-flow API tests passed: complete, partial, unavailable and empty-series responses.');
