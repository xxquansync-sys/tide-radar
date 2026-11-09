module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'Method not allowed' })); }

  const symbol = String((req.query && req.query.symbol) || '').toUpperCase();
  const start = Number(req.query && req.query.start), end = Number(req.query && req.query.end);
  if (!/^[A-Z0-9]{2,20}$/.test(symbol) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86400000) {
    res.statusCode = 400; return res.end(JSON.stringify({ error: 'Invalid symbol or candle time range' }));
  }

  async function request(url) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'TideRadar/1.0' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  // OKX history-trades supports timestamp pagination and up to three months of public trade history.
  // Page backwards from candle end; never substitute current "recent trades" for an old candle.
  const instId = symbol + '-USDT-SWAP', rows = [], maxPages = 8;
  let cursor = String(Math.floor(end)), pages = 0, reachedStart = false, capped = false, error = null;
  try {
    for (let page = 0; page < maxPages; page++) {
      const url = 'https://www.okx.com/api/v5/market/history-trades?instId=' + encodeURIComponent(instId) + '&type=2&after=' + encodeURIComponent(cursor) + '&limit=100';
      const data = await request(url);
      if (!data || data.code !== '0' || !Array.isArray(data.data)) throw new Error((data && data.msg) || 'Invalid OKX response');
      const batch = data.data.map(x => ({ id: String(x.tradeId || ''), ts: Number(x.ts), p: Number(x.px), q: Number(x.sz), side: String(x.side || '').toLowerCase() }))
        .filter(x => Number.isFinite(x.ts) && x.p > 0 && x.q > 0 && (x.side === 'buy' || x.side === 'sell'));
      pages++;
      rows.push(...batch);
      if (!batch.length) { reachedStart = true; break; }
      const oldest = Math.min(...batch.map(x => x.ts));
      if (oldest <= start) { reachedStart = true; break; }
      const next = String(oldest);
      if (next === cursor) break;
      cursor = next;
      if (page < maxPages - 1) await new Promise(resolve => setTimeout(resolve, 110));
    }
    if (!reachedStart && pages >= maxPages) capped = true;
  } catch (e) { error = String(e && e.message || e); }

  const matched = rows.filter(x => x.ts >= start && x.ts < end);
  const unique = Array.from(new Map(matched.map(x => [x.id, x])).values()).sort((a,b) => a.ts-b.ts);

  // Add a compact surrounding campaign context from OKX contract OI and taker-volume series.
  // These are aggregate market statistics, not account-level positioning.
  const candleMs = end - start;
  const period = candleMs >= 86400000 ? '1D' : candleMs >= 14400000 ? '4H' : candleMs >= 3600000 ? '1H' : candleMs >= 900000 ? '15m' : '5m';
  const periodMs = ({ '5m': 300000, '15m': 900000, '1H': 3600000, '4H': 14400000, '1D': 86400000 })[period];
  const contextBegin = Math.max(0, start - periodMs * 6);
  const contextEnd = end + periodMs * 6;
  async function readSeries(path) {
    const url = 'https://www.okx.com' + path + '?instId=' + encodeURIComponent(instId) +
      '&period=' + encodeURIComponent(period) + '&begin=' + contextBegin + '&end=' + contextEnd + '&limit=100';
    const payload = await request(url);
    if (!payload || payload.code !== '0' || !Array.isArray(payload.data)) throw new Error((payload && payload.msg) || 'Invalid OKX series response');
    return payload.data;
  }
  const [oiResult, takerResult] = await Promise.allSettled([
    readSeries('/api/v5/rubik/stat/contracts/open-interest-history'),
    readSeries('/api/v5/rubik/stat/taker-volume-contract')
  ]);
  const oi = oiResult.status === 'fulfilled' ? oiResult.value.map(x => ({
    ts: Number(x[0]), contracts: Number(x[1]), coin: Number(x[2]), usd: Number(x[3])
  })).filter(x => Number.isFinite(x.ts) && Number.isFinite(x.usd)).sort((a,b) => a.ts-b.ts) : [];
  const taker = takerResult.status === 'fulfilled' ? takerResult.value.map(x => ({
    ts: Number(x[0]), sell: Number(x[1]), buy: Number(x[2])
  })).filter(x => Number.isFinite(x.ts) && Number.isFinite(x.buy) && Number.isFinite(x.sell)).sort((a,b) => a.ts-b.ts) : [];

  const result = {
    name: 'OKX', ok: !error, error, rows: unique, sampledRows: rows.length, matchedRows: unique.length,
    pages, capped, complete: reachedStart && !error,
    sampleFrom: rows.length ? Math.min(...rows.map(x => x.ts)) : null,
    sampleTo: rows.length ? Math.max(...rows.map(x => x.ts)) : null,
    coverageStart: rows.length ? Math.min(...rows.map(x => x.ts)) : null,
    coverageEnd: rows.length ? Math.max(...rows.map(x => x.ts)) : null,
    campaign: {
      period, periodMs, oi, taker,
      oiError: oiResult.status === 'rejected' ? String(oiResult.reason && oiResult.reason.message || oiResult.reason) : null,
      takerError: takerResult.status === 'rejected' ? String(takerResult.reason && takerResult.reason.message || takerResult.reason) : null
    },
    source: 'OKX public historical trades + contract open interest + taker volume'
  };
  res.statusCode = 200;
  return res.end(JSON.stringify({ symbol, instId, start, end, updated: Date.now(), exchanges: [result] }));
};
