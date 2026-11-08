module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) { res.statusCode = 503; return res.end(JSON.stringify({ enabled: false, error: 'Archive database is not configured' })); }
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const endpoint = (base.endsWith('/') ? base.slice(0, -1) : base) + '/rest/v1/flow_events';
  try {
    if (req.method === 'GET') {
      const r = await fetch(endpoint + '?select=event_key,symbol,kind,source,amount,venues,trade_id,ts,price,return15,return60,observed_at&order=ts.desc&limit=300', { headers });
      const body = await r.text(); if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ': ' + body.slice(0, 300));
      return res.end(JSON.stringify({ enabled: true, events: JSON.parse(body) }));
    }
    if (req.method === 'POST') {
      const origin = req.headers && req.headers.origin;
      const host = req.headers && req.headers.host;
      if (!origin || !host || new URL(origin).host !== host) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ enabled: false, error: 'Same-origin requests only' }));
      }
      const length = Number(req.headers['content-length'] || 0);
      if (length > 128 * 1024) {
        res.statusCode = 413;
        return res.end(JSON.stringify({ enabled: false, error: 'Payload too large' }));
      }
      let payload = req.body;
      if (typeof payload === 'string') {
        if (payload.length > 128 * 1024) {
          res.statusCode = 413;
          return res.end(JSON.stringify({ enabled: false, error: 'Payload too large' }));
        }
        try { payload = JSON.parse(payload); } catch (_) { payload = null; }
      }
      const incoming = payload && Array.isArray(payload.events) ? payload.events.slice(0, 100) : [];
      const allowedKinds = new Set(['multiBuy', 'multiSell', 'largeBuy', 'largeSell']);
      const rows = incoming.filter(e => {
        if (!e || !/^[A-Z0-9]{2,20}$/.test(String(e.symbol || ''))) return false;
        if (typeof e.key !== 'string' || e.key.length > 180 || e.key.indexOf(String(e.symbol) + '|') !== 0) return false;
        if (!allowedKinds.has(String(e.kind || ''))) return false;
        if (!['cross', 'OKX', 'Binance', 'Bybit'].includes(String(e.source || ''))) return false;
        const ts = Number(e.ts), price = Number(e.price), amount = Number(e.amount);
        if (!Number.isFinite(ts) || ts < Date.now() - 90 * 86400000 || ts > Date.now() + 5 * 60000) return false;
        if (!Number.isFinite(price) || price <= 0 || price > 1e9) return false;
        if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) return false;
        return true;
      }).map(e => {
        const ts = Number(e.ts);
        const observed = Number(e.observedAt);
        const validReturn = v => Number.isFinite(v) && Math.abs(v) <= 1000 ? v : null;
        return {
          event_key: e.key, symbol: String(e.symbol), kind: String(e.kind), source: String(e.source),
          amount: Number(e.amount), venues: String(e.venues || '').slice(0, 120),
          trade_id: String(e.tradeId || '').slice(0, 120),
          ts: new Date(ts).toISOString(), price: Number(e.price),
          return15: validReturn(e.return15), return60: validReturn(e.return60),
          observed_at: new Date(Number.isFinite(observed) ? Math.min(observed, Date.now() + 5 * 60000) : ts).toISOString()
        };
      });
      if (!rows.length) return res.end(JSON.stringify({ enabled: true, saved: 0 }));
      const r = await fetch(endpoint + '?on_conflict=event_key', {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows)
      });
      const body = await r.text();
      if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ': ' + body.slice(0, 300));
      return res.end(JSON.stringify({ enabled: true, saved: rows.length }));
    }
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (error) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ enabled: false, error: String(error && error.message || error).slice(0, 500) }));
  }
};