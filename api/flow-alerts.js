module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) { res.statusCode = 503; return res.end(JSON.stringify({ enabled: false, error: 'Alert database is not configured' })); }
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const endpoint = (base.endsWith('/') ? base.slice(0, -1) : base) + '/rest/v1/flow_alerts';
  try {
    if (req.method === 'GET') {
      const r = await fetch(endpoint + '?select=alert_key,symbol,alert_type,level,direction,title,detail,venues,amount,ts,price,oi_delta&order=ts.desc&limit=300', { headers });
      const body = await r.text(); if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ': ' + body.slice(0, 300));
      return res.end(JSON.stringify({ enabled: true, alerts: JSON.parse(body) }));
    }
    if (req.method === 'POST') {
      const origin = req.headers && req.headers.origin, host = req.headers && req.headers.host;
      if (!origin || !host || new URL(origin).host !== host) { res.statusCode = 403; return res.end(JSON.stringify({ enabled: false, error: 'Same-origin requests only' })); }
      const length = Number(req.headers['content-length'] || 0);
      if (length > 128 * 1024) { res.statusCode = 413; return res.end(JSON.stringify({ enabled: false, error: 'Payload too large' })); }
      let payload = req.body;
      if (typeof payload === 'string') { if (payload.length > 128 * 1024) { res.statusCode = 413; return res.end(JSON.stringify({ enabled: false, error: 'Payload too large' })); } try { payload = JSON.parse(payload); } catch (_) { payload = null; } }
      const incoming = payload && Array.isArray(payload.alerts) ? payload.alerts.slice(0, 100) : [];
      const types = new Set(['crossConsensus', 'largeCluster', 'topTraderShift', 'microstructureShift']);
      const rows = incoming.filter(a => {
        if (!a || !/^[A-Z0-9]{2,20}$/.test(String(a.symbol || ''))) return false;
        if (typeof a.key !== 'string' || a.key.length > 180 || a.key.indexOf(String(a.symbol) + '|') !== 0) return false;
        if (!types.has(String(a.type || '')) || !['high', 'watch'].includes(String(a.level || '')) || !['buy', 'sell'].includes(String(a.direction || ''))) return false;
        const ts = Number(a.ts), price = Number(a.price), amount = Number(a.amount), oi = Number(a.oiDelta || 0);
        if (!Number.isFinite(ts) || ts < Date.now() - 90 * 86400000 || ts > Date.now() + 5 * 60000) return false;
        if (!Number.isFinite(price) || price < 0 || price > 1e9 || !Number.isFinite(amount) || amount < 0 || amount > 1e12 || !Number.isFinite(oi) || Math.abs(oi) > 1e15) return false;
        return true;
      }).map(a => ({
        alert_key: a.key, symbol: String(a.symbol), alert_type: String(a.type), level: String(a.level), direction: String(a.direction),
        title: String(a.title || '').slice(0, 100), detail: String(a.detail || '').slice(0, 300), venues: String(a.venues || '').slice(0, 120),
        amount: Number(a.amount) || 0, ts: new Date(Number(a.ts)).toISOString(), price: Number(a.price) || 0, oi_delta: Number(a.oiDelta) || 0
      }));
      if (!rows.length) return res.end(JSON.stringify({ enabled: true, saved: 0 }));
      const r = await fetch(endpoint + '?on_conflict=alert_key', { method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      const body = await r.text(); if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ': ' + body.slice(0, 300));
      return res.end(JSON.stringify({ enabled: true, saved: rows.length }));
    }
    res.statusCode = 405; return res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (error) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ enabled: false, error: String(error && error.message || error).slice(0, 500) }));
  }
};
