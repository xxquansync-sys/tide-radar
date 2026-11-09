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

  // Historical public trades are not timestamp-seekable on OKX.
  // Use time-bucketed contract taker volume + OI for the selected candle instead of showing unrelated latest trades.
  const instId = symbol + '-USDT-SWAP';
  // Add a compact surrounding campaign context from OKX contract OI and taker-volume series.
  // These are aggregate market statistics, not account-level positioning.
  const candleMs = end - start;
  const period = candleMs >= 86400000 ? '1D' : candleMs >= 43200000 ? '12H' : candleMs >= 21600000 ? '6H' : candleMs >= 14400000 ? '4H' : candleMs >= 7200000 ? '2H' : candleMs >= 3600000 ? '1H' : candleMs >= 1800000 ? '30m' : candleMs >= 900000 ? '15m' : '5m';
  const periodMs = ({ '5m': 300000, '15m': 900000, '30m': 1800000, '1H': 3600000, '2H': 7200000, '4H': 14400000, '6H': 21600000, '12H': 43200000, '1D': 86400000 })[period];
  const contextBegin = Math.max(0, start - periodMs * 12);
  const contextEnd = end + periodMs * 12;
  async function readSeries(path, extra) {
    const url = 'https://www.okx.com' + path + '?instId=' + encodeURIComponent(instId) +
      '&period=' + encodeURIComponent(period) + '&begin=' + contextBegin + '&end=' + contextEnd + '&limit=100' + (extra || '');
    const payload = await request(url);
    if (!payload || payload.code !== '0' || !Array.isArray(payload.data)) throw new Error((payload && payload.msg) || 'Invalid OKX series response');
    return payload.data;
  }
  const [oiResult, takerResult] = await Promise.allSettled([
    readSeries('/api/v5/rubik/stat/contracts/open-interest-history'),
    readSeries('/api/v5/rubik/stat/taker-volume-contract', '&unit=2')
  ]);
  const oi = oiResult.status === 'fulfilled' ? oiResult.value.map(x => ({
    ts: Number(x[0]), contracts: Number(x[1]), coin: Number(x[2]), usd: Number(x[3])
  })).filter(x => Number.isFinite(x.ts) && Number.isFinite(x.usd)).sort((a,b) => a.ts-b.ts) : [];
  const taker = takerResult.status === 'fulfilled' ? takerResult.value.map(x => ({
    ts: Number(x[0]), sell: Number(x[1]), buy: Number(x[2])
  })).filter(x => Number.isFinite(x.ts) && Number.isFinite(x.buy) && Number.isFinite(x.sell)).sort((a,b) => a.ts-b.ts) : [];

  const result = {
    name: 'OKX', ok: true, error: null, rows: [], sampledRows: 0, matchedRows: 0,
    pages: 0, capped: false, complete: false, tradeCoverage: 'aggregate-only',
    sampleFrom: null, sampleTo: null, coverageStart: null, coverageEnd: null,
    campaign: {
      period, periodMs, oi, taker, takerUnit: 'U',
      oiError: oiResult.status === 'rejected' ? String(oiResult.reason && oiResult.reason.message || oiResult.reason) : null,
      takerError: takerResult.status === 'rejected' ? String(takerResult.reason && takerResult.reason.message || takerResult.reason) : null
    },
    source: 'OKX public historical trades + contract open interest + taker volume'
  };
  res.statusCode = 200;
  return res.end(JSON.stringify({ symbol, instId, start, end, updated: Date.now(), exchanges: [result] }));
};
