module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=10, s-maxage=10, stale-while-revalidate=20');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ enabled: false, error: 'Method not allowed' })); }
  const symbol = String((req.query && req.query.symbol) || '').toUpperCase();
  if (!['ETH','WLD'].includes(symbol)) { res.statusCode = 400; return res.end(JSON.stringify({ enabled: false, error: 'Unsupported symbol' })); }
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) { res.statusCode = 503; return res.end(JSON.stringify({ enabled: false, error: 'Microstructure archive is not configured' })); }
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const root = (base.endsWith('/') ? base.slice(0,-1) : base) + '/rest/v1/';
  const headers = { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' };
  async function read(table, query) {
    const response = await fetch(root + table + '?' + query, { headers });
    const body = await response.text();
    if (!response.ok) throw new Error(table + ' HTTP ' + response.status + ': ' + body.slice(0,250));
    return JSON.parse(body);
  }
  const results = await Promise.allSettled([
    read('micro_trade_samples', 'select=trade_id,ts,side,price,size_contracts,notional_usd&symbol=eq.' + symbol + '&ts=gte.' + encodeURIComponent(since) + '&order=ts.desc&limit=500'),
    read('micro_book_snapshots', 'select=ts,best_bid,best_ask,spread_pct,bid_depth_10_usd,ask_depth_10_usd,levels&symbol=eq.' + symbol + '&ts=gte.' + encodeURIComponent(since) + '&order=ts.desc&limit=120'),
    read('micro_sample_runs', 'select=started_at,completed_at,trade_rows_received,trade_rows_valid,trade_rows_archived,trade_oldest_at,trade_newest_at,trade_coverage_seconds,trade_coverage_status,book_snapshot_at,errors&symbol=eq.' + symbol + '&order=completed_at.desc&limit=30')
  ]);
  const names = ['trades','books','runs'], output = { enabled: true, symbol, windowMinutes: 30, fetchedAt: new Date().toISOString() };
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') output[names[i]] = result.value;
    else { output[names[i]] = []; output[names[i] + 'Error'] = String(result.reason && result.reason.message || result.reason); }
  });
  output.latestRun = output.runs[0] || null;
  output.archiveState = results.every(x => x.status === 'fulfilled') ? 'ready' : 'partial';
  res.statusCode = 200;
  return res.end(JSON.stringify(output));
};
