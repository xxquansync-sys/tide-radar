const OKX = 'https://www.okx.com';
const SUPABASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const VENUE = 'OKX';
const ASSETS = [
  { asset: 'BTC', spot: 'BTC-USDT', swap: 'BTC-USDT-SWAP' },
  { asset: 'ETH', spot: 'ETH-USDT', swap: 'ETH-USDT-SWAP' },
  { asset: 'WLD', spot: 'WLD-USDT', swap: 'WLD-USDT-SWAP' }
];
const iso = (value) => new Date(value).toISOString();

async function get(path) {
  const response = await fetch(OKX + path, { headers: { Accept: 'application/json', 'User-Agent': 'TideRadar-Capital-Context/1.0' } });
  const body = await response.json();
  if (!response.ok || !body || body.code !== '0' || !Array.isArray(body.data)) {
    throw new Error('OKX ' + response.status + ': ' + ((body && (body.msg || body.code)) || 'invalid response'));
  }
  return body.data;
}

function observation(asset, instrument, marketType, metric, value, unit, timestamp, quality = 'observed', metadata = {}) {
  const observedAt = iso(Number(timestamp) || Date.now());
  return {
    observation_key: [VENUE, instrument, metric, observedAt].join(':'),
    venue: VENUE,
    instrument_id: instrument,
    asset,
    market_type: marketType,
    metric,
    metric_value: value,
    unit,
    observed_at: observedAt,
    source: 'OKX public REST',
    data_quality: quality,
    metadata
  };
}

function makeObservations(asset, spot, swap, oi, funding) {
  const rows = [];
  const spotTs = Number(spot.ts) || Date.now();
  const swapTs = Number(swap.ts) || Date.now();
  const oiTs = Number(oi.ts) || Date.now();
  const fundingTs = Number(funding.ts) || Date.now();
  const spotPx = Number(spot.last);
  const swapPx = Number(swap.last);
  const oiUsd = Number(oi.oiUsd);
  const oiContracts = Number(oi.oi);
  const oiCoin = Number(oi.oiCcy);
  const fundingRate = Number(funding.fundingRate);

  if (spotPx > 0) rows.push(observation(asset.asset, asset.spot, 'spot', 'last_price', spotPx, 'USDT', spotTs, 'observed', { bid: spot.bidPx, ask: spot.askPx }));
  if (swapPx > 0) rows.push(observation(asset.asset, asset.swap, 'swap', 'last_price', swapPx, 'USDT', swapTs, 'observed', { bid: swap.bidPx, ask: swap.askPx }));
  if (Number.isFinite(oiUsd) && oiUsd >= 0) rows.push(observation(asset.asset, asset.swap, 'swap', 'open_interest_usd', oiUsd, 'USD', oiTs, 'observed', { oi_contracts: Number.isFinite(oiContracts) ? oiContracts : null, oi_coin: Number.isFinite(oiCoin) ? oiCoin : null }));
  if (Number.isFinite(fundingRate)) rows.push(observation(asset.asset, asset.swap, 'swap', 'funding_rate', fundingRate, 'rate', fundingTs, 'observed', { funding_time: funding.fundingTime || null, next_funding_time: funding.nextFundingTime || null, realized_rate: funding.realizedRate || null }));
  if (spotPx > 0 && swapPx > 0) {
    const ts = Math.max(spotTs, swapTs);
    rows.push(observation(asset.asset, asset.swap, 'aggregate', 'spot_swap_basis_pct', (swapPx / spotPx - 1) * 100, '%', ts, 'estimated', { spot_price: spotPx, swap_price: swapPx, spot_ts: spotTs, swap_ts: swapTs }));
  }
  return rows;
}

async function write(rows) {
  if (!rows.length) return;
  const response = await fetch(SUPABASE + '/rest/v1/capital_market_observations?on_conflict=observation_key', {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: 'Bearer ' + KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!response.ok) throw new Error('Supabase capital_market_observations HTTP ' + response.status + ': ' + (await response.text()).slice(0, 400));
}

async function collect(asset) {
  const errors = {};
  const results = await Promise.allSettled([
    get('/api/v5/market/ticker?instId=' + encodeURIComponent(asset.spot)),
    get('/api/v5/market/ticker?instId=' + encodeURIComponent(asset.swap)),
    get('/api/v5/public/open-interest?instType=SWAP&instId=' + encodeURIComponent(asset.swap)),
    get('/api/v5/public/funding-rate?instId=' + encodeURIComponent(asset.swap))
  ]);
  const names = ['spot_ticker', 'swap_ticker', 'open_interest', 'funding_rate'];
  const data = {};
  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value[0]) data[names[index]] = result.value[0];
    else errors[names[index]] = result.status === 'rejected' ? String(result.reason?.message || result.reason) : 'empty response';
  });
  const complete = Boolean(data.spot_ticker && data.swap_ticker && data.open_interest && data.funding_rate);
  if (!complete) console.log(JSON.stringify({ asset: asset.asset, status: 'partial', errors }));
  const rows = complete ? makeObservations(asset, data.spot_ticker, data.swap_ticker, data.open_interest, data.funding_rate) : [];
  if (rows.length) await write(rows);
  console.log(JSON.stringify({ asset: asset.asset, status: rows.length === 5 ? 'complete' : rows.length ? 'partial' : 'unavailable', observations: rows.length, metrics: rows.map(x => x.metric), errors }));
  return rows.length;
}

function test() {
  const asset = ASSETS[0];
  const rows = makeObservations(asset,
    { last: '68000', bidPx: '67999', askPx: '68001', ts: '1760000000000' },
    { last: '68068', bidPx: '68067', askPx: '68069', ts: '1760000001000' },
    { oiUsd: '123456789', oi: '1815', oiCcy: '1815', ts: '1760000002000' },
    { fundingRate: '0.0001', fundingTime: '1760000003000', ts: '1760000003000' });
  const expected = ['last_price', 'last_price', 'open_interest_usd', 'funding_rate', 'spot_swap_basis_pct'];
  if (rows.length !== 5 || expected.some((metric, index) => rows[index].metric !== metric)) throw new Error('market context mapping test failed');
  const basis = rows.find(x => x.metric === 'spot_swap_basis_pct');
  if (Math.abs(basis.metric_value - 0.1) > 1e-9 || basis.data_quality !== 'estimated') throw new Error('basis calculation test failed');
  if (rows.find(x => x.metric === 'open_interest_usd').metric_value !== 123456789) throw new Error('OI mapping test failed');
  console.log('Market context tests passed: spot/swap prices, OI, funding, basis, quality.');
}

async function main() {
  if (!SUPABASE || !KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  let total = 0;
  for (const asset of ASSETS) {
    try { total += await collect(asset); }
    catch (error) { console.error(asset.asset + ' market context failed:', error.message || error); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ totalObservations: total }));
}

if (process.env.TIDE_MARKET_CONTEXT_TEST === '1') test();
else main().catch(error => { console.error(error); process.exitCode = 1; });
