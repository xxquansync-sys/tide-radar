import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync('api/capital-reserves.js', 'utf8');
const calls = [];
const responses = [
  [[{ id: 'entity-1', display_name: 'OKX Exchange', entity_key: 'okx:exchange' }], '0-0/1'],
  [[
    { asset: 'BTC', reserve_amount: '100.25', snapshot_at: '2026-10-31T16:00:00Z', source: 'okx_por', source_url: 'https://example.test/por.csv', data_quality: 'observed' },
    { asset: 'ETH', reserve_amount: '2000', snapshot_at: '2026-10-31T16:00:00Z', source: 'okx_por', source_url: null, data_quality: 'partial' }
  ], '0-1/2'],
  [[
    { asset: 'BTC', amount: '1.5', usd_value: '100000', account: { network: 'Bitcoin', account_ref: 'bc1qexamplewallet000000000000000000000000', account_kind: 'wallet', account_role: 'unknown' } },
    { asset: 'BTC', amount: '0.8', usd_value: '50000', account: { network: 'Bitcoin', account_ref: 'bc1qsecondwallet0000000000000000000000000', account_kind: 'wallet', account_role: 'unknown' } }
  ], '0-1/2']
];
const sandbox = {
  module: { exports: {} },
  process: { env: { SUPABASE_URL: 'https://supabase.example', SUPABASE_SECRET_KEY: 'test-secret' } },
  fetch: async (url, options) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected fetch: ' + url);
    const [rows, contentRange] = next;
    return {
      ok: true,
      headers: { get: name => name.toLowerCase() === 'content-range' ? contentRange : null },
      text: async () => JSON.stringify(rows)
    };
  },
  Map,
  Date,
  Number,
  String,
  JSON,
  encodeURIComponent,
  console
};
vm.runInNewContext(source, sandbox, { filename: 'api/capital-reserves.js' });
const handler = sandbox.module.exports;

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value || ''; }
  };
}

const methodRes = response();
await handler({ method: 'POST' }, methodRes);
assert.equal(methodRes.statusCode, 405);
assert.equal(calls.length, 0);

const res = response();
await handler({ method: 'GET' }, res);
assert.equal(res.statusCode, 200);
const data = JSON.parse(res.body);
assert.equal(data.enabled, true);
assert.equal(data.entityKey, 'okx:exchange');
assert.equal(data.assetCount, 2);
assert.equal(data.walletRowsReturned, 2);
assert.equal(data.assets.find(x => x.asset === 'BTC').trackedWalletCount, 2);
assert.equal(data.assets.find(x => x.asset === 'BTC').topWallets.length, 2);
assert.equal(data.assets.find(x => x.asset === 'ETH').trackedWalletCount, 0);
assert.equal(data.assets.find(x => x.asset === 'ETH').dataQuality, 'partial');
assert.ok(calls[2].url.includes('account.entity_id=eq.entity-1'));
assert.ok(calls.every(x => x.options.headers.Authorization === 'Bearer test-secret'));
console.log('OKX reserve API tests passed: GET-only, entity scoping, snapshot filtering, partial assets, and wallet sample grouping.');
