module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=15, stale-while-revalidate=30');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    return res.end(JSON.stringify({ enabled: false, error: 'Method not allowed' }));
  }
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ enabled: false, error: 'Capital behavior data source is not configured' }));
  }
  const root = (base.endsWith('/') ? base.slice(0, -1) : base) + '/rest/v1/';
  const headers = { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' };
  async function read(table, query) {
    const response = await fetch(root + table + '?' + query, { headers });
    const body = await response.text();
    if (!response.ok) throw new Error(table + ' HTTP ' + response.status + ': ' + body.slice(0, 240));
    return body ? JSON.parse(body) : [];
  }
  try {
    const events = await read('capital_behavior_events',
      'select=id,event_key,symbol,instrument_id,event_type,direction,evidence_strength,status,started_at,ended_at,reference_price,summary,limitations' +
      '&order=started_at.desc&limit=60');
    if (!events.length) return res.end(JSON.stringify({ enabled: true, events: [], updatedAt: new Date().toISOString() }));
    const ids = events.map(event => event.id).filter(id => /^[0-9a-f-]{36}$/i.test(String(id)));
    if (!ids.length) return res.end(JSON.stringify({ enabled: true, events: [], updatedAt: new Date().toISOString() }));
    const idFilter = 'in.(' + ids.join(',') + ')';
    const [evidence, outcomes] = await Promise.all([
      read('capital_behavior_evidence',
        'select=id,event_id,evidence_type,source,observed_at,window_seconds,direction,evidence_state,metrics,explanation' +
        '&event_id=' + encodeURIComponent(idFilter) + '&order=observed_at.desc&limit=400'),
      read('capital_behavior_outcomes',
        'select=event_id,horizon_minutes,reference_price,evaluated_price,return_pct,max_favorable_excursion_pct,max_adverse_excursion_pct,evaluation_status,data_quality,evaluated_at' +
        '&event_id=' + encodeURIComponent(idFilter) + '&order=horizon_minutes.asc&limit=180')
    ]);
    const evidenceByEvent = new Map(), outcomesByEvent = new Map();
    evidence.forEach(row => {
      const list = evidenceByEvent.get(row.event_id) || [];
      list.push({
        id: row.id, type: row.evidence_type, source: row.source, observedAt: row.observed_at,
        windowSeconds: row.window_seconds, direction: row.direction, state: row.evidence_state,
        metrics: row.metrics || {}, explanation: row.explanation
      });
      evidenceByEvent.set(row.event_id, list);
    });
    outcomes.forEach(row => {
      const list = outcomesByEvent.get(row.event_id) || [];
      list.push({
        horizonMinutes: row.horizon_minutes, referencePrice: row.reference_price,
        evaluatedPrice: row.evaluated_price, returnPct: row.return_pct,
        maxFavorableExcursionPct: row.max_favorable_excursion_pct,
        maxAdverseExcursionPct: row.max_adverse_excursion_pct,
        status: row.evaluation_status, dataQuality: row.data_quality, evaluatedAt: row.evaluated_at
      });
      outcomesByEvent.set(row.event_id, list);
    });
    return res.end(JSON.stringify({
      enabled: true,
      updatedAt: new Date().toISOString(),
      eventCount: events.length,
      events: events.map(event => ({
        id: event.id, eventKey: event.event_key, symbol: event.symbol, instrumentId: event.instrument_id,
        type: event.event_type, direction: event.direction, evidenceStrength: event.evidence_strength,
        status: event.status, startedAt: event.started_at, endedAt: event.ended_at,
        referencePrice: event.reference_price, summary: event.summary,
        limitations: Array.isArray(event.limitations) ? event.limitations : [],
        evidence: evidenceByEvent.get(event.id) || [],
        outcomes: outcomesByEvent.get(event.id) || []
      }))
    }));
  } catch (error) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ enabled: false, error: String(error && error.message || error).slice(0, 400) }));
  }
};
