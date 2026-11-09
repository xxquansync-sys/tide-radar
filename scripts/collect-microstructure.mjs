const OKX = 'https://www.okx.com';
const SUPABASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SYMBOLS = [
  { symbol: 'ETH', instId: 'ETH-USDT-SWAP', base: 'ETH', quote: 'USDT' },
  { symbol: 'WLD', instId: 'WLD-USDT-SWAP', base: 'WLD', quote: 'USDT' }
];
const now = Date.now();
const iso = (ts) => new Date(ts).toISOString();

async function request(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'TideRadar-Microstructure-Collector/1.0' }
      });
      const body = await response.json();
      if (!response.ok || !body || body.code !== '0' || !Array.isArray(body.data)) {
        throw new Error('OKX ' + response.status + ': ' + ((body && (body.msg || body.code)) || 'invalid response'));
      }
      return body.data;
    } catch (error) {
      last = error;
      if (i + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 700 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last || new Error('OKX request failed');
}

async function db(table, rows, conflict) {
  if (!rows.length) return;
  const url = SUPABASE + '/rest/v1/' + table + (conflict ? '?on_conflict=' + encodeURIComponent(conflict) : '');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: 'Bearer ' + KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!response.ok) throw new Error('Supabase ' + table + ' HTTP ' + response.status + ': ' + (await response.text()).slice(0, 400));
}

async function collect(item) {
  const started = Date.now();
  const errors = {};
  let instrument, trades = [], book;
  try {
    const rows = await request(OKX + '/api/v5/public/instruments?instType=SWAP&instId=' + encodeURIComponent(item.instId));
    instrument = rows.find(x => x.instId === item.instId);
    if (!instrument || instrument.state !== 'live') throw new Error('Instrument unavailable or not live');
  } catch (error) {
    errors.instrument = String(error.message || error);
  }
  const ctVal = instrument ? Number(instrument.ctVal) : NaN;
  const ctValCcy = instrument && instrument.ctValCcy;
  const multiplier = (price) => {
    if (!(ctVal > 0)) return NaN;
    if (ctValCcy === item.base) return ctVal * price;
    if (ctValCcy === item.quote) return ctVal;
    return NaN;
  };

  if (instrument) {
    try {
      trades = await request(OKX + '/api/v5/market/trades?instId=' + encodeURIComponent(item.instId) + '&limit=500');
    } catch (error) { errors.trades = String(error.message || error); }
    try {
      const rows = await request(OKX + '/api/v5/market/books?instId=' + encodeURIComponent(item.instId) + '&sz=50');
      book = rows[0];
      if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) throw new Error('Malformed order book');
    } catch (error) { errors.book = String(error.message || error); }
  }

  const validTrades = trades.map(x => {
    const ts = Number(x.ts), price = Number(x.px), size = Number(x.sz), factor = multiplier(price);
    const usd = size * factor;
    if (!(ts > 0 && price > 0 && size > 0 && Number.isFinite(usd) && usd > 0) || !['buy','sell'].includes(x.side)) return null;
    return { id: String(x.tradeId || ''), ts, price, size, side: x.side, usd };
  }).filter(Boolean).sort((a,b) => a.ts-b.ts);
  const tradeTimes = validTrades.map(x => x.ts);
  const newest = tradeTimes.length ? Math.max(...tradeTimes) : null;
  const oldest = tradeTimes.length ? Math.min(...tradeTimes) : null;
  const coverage = tradeTimes.length > 1 ? Math.round((newest-oldest)/1000) : 0;
  const stale = newest === null || Date.now()-newest > 180000;
  const coverageStatus = !validTrades.length ? 'unavailable' : stale ? 'stale' : coverage < 240 ? 'partial' : 'usable';

  const tradeRows = validTrades.filter(x => x.usd >= 5000 && x.id).map(x => ({
    sample_key: item.symbol + ':' + x.id,
    symbol: item.symbol,
    inst_id: item.instId,
    trade_id: x.id,
    ts: iso(x.ts),
    side: x.side,
    price: x.price,
    size_contracts: x.size,
    notional_usd: Math.round(x.usd * 100) / 100,
    observed_at: iso(Date.now())
  }));

  let bookRow = [];
  if (book) {
    const mapLevels = (levels, side) => levels.map(level => {
      const price = Number(level[0]), size = Number(level[1]), orders = Number(level[3]) || 0;
      const usd = size * multiplier(price);
      if (!(price > 0 && size > 0 && Number.isFinite(usd) && usd > 0)) return null;
      return { side, price, sizeContracts: size, usd: Math.round(usd * 100) / 100, orders };
    }).filter(Boolean);
    const bids = mapLevels(book.bids, 'buy');
    const asks = mapLevels(book.asks, 'sell');
    const bestBid = bids[0] && bids[0].price;
    const bestAsk = asks[0] && asks[0].price;
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
    const spreadPct = mid && bestAsk >= bestBid ? (bestAsk - bestBid) / mid * 100 : null;
    const snapshotTs = Number(book.ts) || Date.now();
    bookRow = [{
      snapshot_key: item.symbol + ':' + snapshotTs,
      symbol: item.symbol,
      inst_id: item.instId,
      ts: iso(snapshotTs),
      best_bid: bestBid || null,
      best_ask: bestAsk || null,
      spread_pct: spreadPct,
      bid_depth_10_usd: bids.slice(0,10).reduce((sum,x)=>sum+x.usd,0),
      ask_depth_10_usd: asks.slice(0,10).reduce((sum,x)=>sum+x.usd,0),
      levels: bids.concat(asks),
      observed_at: iso(Date.now())
    }];
  }

  const completed = Date.now();
  const run = {
    run_key: item.symbol + ':' + started,
    symbol: item.symbol,
    inst_id: item.instId,
    started_at: iso(started),
    completed_at: iso(completed),
    trade_rows_received: trades.length,
    trade_rows_valid: validTrades.length,
    trade_rows_archived: tradeRows.length,
    trade_oldest_at: oldest ? iso(oldest) : null,
    trade_newest_at: newest ? iso(newest) : null,
    trade_coverage_seconds: coverage,
    trade_coverage_status: coverageStatus,
    book_snapshot_at: book && book.ts ? iso(Number(book.ts)) : null,
    errors,
    source: 'OKX public REST'
  };

  await db('micro_trade_samples', tradeRows, 'sample_key');
  await db('micro_book_snapshots', bookRow, 'snapshot_key');
  await db('micro_sample_runs', [run], 'run_key');
  console.log(JSON.stringify({
    symbol: item.symbol,
    tradesReceived: trades.length,
    tradesArchived: tradeRows.length,
    coverageSeconds: coverage,
    coverageStatus,
    bookSnapshot: bookRow.length > 0,
    errors
  }));
}

async function prune() {
  const cutoffTrades = encodeURIComponent('lt.' + iso(Date.now() - 14 * 86400000));
  const cutoffBooks = encodeURIComponent('lt.' + iso(Date.now() - 30 * 86400000));
  const cutoffRuns = encodeURIComponent('lt.' + iso(Date.now() - 90 * 86400000));
  for (const [table, field, cutoff] of [
    ['micro_trade_samples','ts',cutoffTrades],
    ['micro_book_snapshots','ts',cutoffBooks],
    ['micro_sample_runs','completed_at',cutoffRuns]
  ]) {
    const response = await fetch(SUPABASE + '/rest/v1/' + table + '?' + field + '=' + cutoff, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Prefer: 'return=minimal' }
    });
    if (!response.ok) throw new Error('Retention cleanup failed for ' + table + ': ' + response.status + ' ' + (await response.text()).slice(0,200));
  }
}

async function main() {
  if (!SUPABASE || !KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY GitHub Actions secret');
  for (const item of SYMBOLS) {
    try { await collect(item); }
    catch (error) { console.error(item.symbol + ' collector failed:', error.message || error); process.exitCode = 1; }
  }
  if (new Date().getUTCHours() === 3 && new Date().getUTCMinutes() < 10) {
    try { await prune(); console.log('Retention cleanup complete'); }
    catch (error) { console.error('Retention cleanup failed:', error.message || error); process.exitCode = 1; }
  }
}
if (process.env.TIDE_COLLECTOR_TEST !== '1') main().catch(error => { console.error(error); process.exitCode = 1; });
