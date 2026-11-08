module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) { res.statusCode = 503; return res.end(JSON.stringify({ enabled: false, error: 'Archive database is not configured' })); }
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const endpoint = base.replace(/\/$/, '') + '/rest/v1/flow_events';
  try {
    if (req.method === 'GET') {
      const r = await fetch(endpoint + '?select=event_key,symbol,kind,source,amount,venues,trade_id,ts,price,return15,return60,observed_at&order=ts.desc&limit=300', { headers });
      const body = await r.text(); if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ': ' + body.slice(0, 300));
      return res.end(JSON.stringify({ enabled: true, events: JSON.parse(body) }));
    }
    if (req.method === 'POST') {
      let payload = req.body;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { payload = null; } }
      const incoming = payload && Array.isArray(payload.events) ? payload.events.slice(0, 100) : [];
      const rows = incoming.filter(e => e && /^[A-Z0-9]{2,20}$/.test(String(e.symbol || '')) && typeof e.key === 'string' && e.key.length < 180 && Number.isFinite(Number(e.ts)) && Number.isFinite(Number(e.price)) && Number(e.price) > 0).map(e => ({
        event_key: e.key, symbol: String(e.symbol), kind: String(e.kind || '').slice(0, 40), source: String(e.source || '').slice(0, 40),
        amount: Math.max(0, Number(e.amount) || 0), venues: String(e.venues || '').slice(0, 120), trade_id: String(e.tradeId || '').slice(0, 120),
        ts: new Date(Number(e.ts)).toISOString(), price: Number(e.price), return15: Number.isFinite(e.return15) ? e.return15 : null,
        return60: Number.isFinite(e.return60) ? e.return60 : null, observed_at: new Date(Number(e.observedAt || e.ts)).toISOString()
      }));
      if (!rows.length) return res.end(JSON.stringify({ enabled: true, saved: 0 }));
      const r = await fetch(endpoint + '?on_conflict=event_key', { method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      const body = await r.text(); if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ': ' + body.slice(0, 300));
      return res.end(JSON.stringify({ enabled: true, saved: rows.length }));
    }
    res.statusCode = 405; return res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (error) { res.statusCode = 502; return res.end(JSON.stringify({ enabled: false, error: String(error && error.message || error).slice(0, 500) })); }
}