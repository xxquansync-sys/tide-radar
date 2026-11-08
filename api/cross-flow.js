module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  const symbol = String((req.query && req.query.symbol) || '').toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Invalid symbol' }));
  }

  async function request(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
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
  const jobs = [
    {
      name: 'Binance',
      run: async () => {
        const rows = await request('https://fapi.binance.com/fapi/v1/aggTrades?symbol=' + pair + '&limit=1000');
        if (!Array.isArray(rows)) throw new Error('Invalid Binance response');
        return rows.map(x => ({
          id: String(x.a), ts: Number(x.T), p: Number(x.p), q: Number(x.q),
          side: x.m ? 'sell' : 'buy'
        }));
      }
    },
    {
      name: 'Bybit',
      run: async () => {
        const data = await request('https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=' + pair + '&limit=1000');
        if (!data || data.retCode !== 0 || !data.result || !Array.isArray(data.result.list)) {
          throw new Error((data && data.retMsg) || 'Invalid Bybit response');
        }
        return data.result.list.map(x => ({
          id: String(x.execId || ''), ts: Number(x.time), p: Number(x.price), q: Number(x.size),
          side: String(x.side || '').toLowerCase()
        }));
      }
    }
  ];

  const exchanges = await Promise.all(jobs.map(async job => {
    try {
      const rows = await job.run();
      return { name: job.name, ok: true, rows };
    } catch (error) {
      return { name: job.name, ok: false, error: String(error && error.message || error), rows: [] };
    }
  }));
  res.statusCode = 200;
  return res.end(JSON.stringify({ symbol, updated: Date.now(), exchanges }));
};
