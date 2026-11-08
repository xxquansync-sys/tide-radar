module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  const symbol = String((req.query && req.query.symbol) || '').toUpperCase();
  const start = Number(req.query && req.query.start);
  const end = Number(req.query && req.query.end);
  if (!/^[A-Z0-9]{2,20}$/.test(symbol) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86400000) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Invalid symbol or candle time range' }));
  }

  async function request(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8500);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'TideRadar/1.0' }
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const pair = symbol + 'USDT';
  const instId = symbol + '-USDT-SWAP';
  const jobs = [
    {
      name: 'Binance',
      run: async () => {
        const rows = await request('https://fapi.binance.com/fapi/v1/aggTrades?symbol=' + pair + '&startTime=' + Math.floor(start) + '&endTime=' + Math.floor(end - 1) + '&limit=1000');
        if (!Array.isArray(rows)) throw new Error('Invalid Binance response');
        return { rows: rows.map(x => ({ id: String(x.a), ts: Number(x.T), p: Number(x.p), q: Number(x.q), side: x.m ? 'sell' : 'buy' })), capped: rows.length >= 1000 };
      }
    },
    {
      name: 'Bybit',
      run: async () => {
        const data = await request('https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=' + pair + '&limit=1000');
        if (!data || data.retCode !== 0 || !data.result || !Array.isArray(data.result.list)) throw new Error((data && data.retMsg) || 'Invalid Bybit response');
        return { rows: data.result.list.map(x => ({ id: String(x.execId || ''), ts: Number(x.time), p: Number(x.price), q: Number(x.size), side: String(x.side || '').toLowerCase() })), capped: data.result.list.length >= 1000 };
      }
    },
    {
      name: 'OKX',
      run: async () => {
        const data = await request('https://www.okx.com/api/v5/market/history-trades?instId=' + encodeURIComponent(instId) + '&type=1&limit=100');
        if (!data || data.code !== '0' || !Array.isArray(data.data)) throw new Error((data && data.msg) || 'Invalid OKX response');
        return { rows: data.data.map(x => ({ id: String(x.tradeId || ''), ts: Number(x.ts), p: Number(x.px), q: Number(x.sz), side: String(x.side || '').toLowerCase() })), capped: data.data.length >= 100 };
      }
    }
  ];

  const exchanges = await Promise.all(jobs.map(async job => {
    try {
      const result = await job.run();
      const rows = result.rows.filter(x => x.ts >= start && x.ts < end && x.p > 0 && x.q > 0 && (x.side === 'buy' || x.side === 'sell'));
      return { name: job.name, ok: true, rows, sampledRows: result.rows.length, matchedRows: rows.length, capped: result.capped, sampleFrom: result.rows.length ? Math.min(...result.rows.map(x => x.ts)) : null, sampleTo: result.rows.length ? Math.max(...result.rows.map(x => x.ts)) : null };
    } catch (error) {
      return { name: job.name, ok: false, error: String(error && error.message || error), rows: [], sampledRows: 0, matchedRows: 0, capped: false };
    }
  }));

  res.statusCode = 200;
  return res.end(JSON.stringify({ symbol, start, end, updated: Date.now(), exchanges }));
};