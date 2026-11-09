import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret';
const handler = require('../api/capital-behavior.js');
const originalFetch = global.fetch;
const eventId = '11111111-1111-4111-8111-111111111111';
global.fetch = async url => {
  const value = String(url);
  let rows = [];
  if (value.includes('/capital_behavior_events?')) {
    rows = [{ id: eventId, event_key: 'ETH:aggressive_execution:buy:test', symbol: 'ETH',
      instrument_id: 'ETH-USDT-SWAP', event_type: 'aggressive_execution', direction: 'buy',
      evidence_strength: 'medium', status: 'confirmed', started_at: '2026-11-10T00:00:00Z',
      ended_at: null, reference_price: 3000, summary: 'Observed public trade cluster.',
      limitations: ['Public sample only'], metadata: { private_internal_value: 'must not leak' } }];
  } else if (value.includes('/capital_behavior_evidence?')) {
    rows = [{ id: 'evidence-1', event_id: eventId, evidence_type: 'open_interest',
      source: 'OKX swap observations', observed_at: '2026-11-10T00:15:00Z', window_seconds: 900,
      direction: 'neutral', evidence_state: 'observed', metrics: { delta_pct: 0.8 },
      explanation: 'Aggregate open interest expanded; direction is not inferred.' }];
  } else if (value.includes('/capital_behavior_outcomes?')) {
    rows = [{ event_id: eventId, horizon_minutes: 15, reference_price: 3000,
      evaluated_price: 3010, return_pct: 0.333, max_favorable_excursion_pct: 0.4,
      max_adverse_excursion_pct: -0.1, evaluation_status: 'complete',
      data_quality: 'complete', evaluated_at: '2026-11-10T00:15:00Z' }];
  }
  return { ok: true, text: async () => JSON.stringify(rows) };
};
function response() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; },
    end(body) { this.body = body; } };
}
try {
  const res = response();
  await handler({ method: 'GET' }, res);
  const payload = JSON.parse(res.body);
  if (!payload.enabled || payload.events.length !== 1) throw new Error('API event response missing');
  if (payload.events[0].evidence.length !== 1 || payload.events[0].outcomes.length !== 1) throw new Error('Nested evidence/outcomes missing');
  if ('metadata' in payload.events[0]) throw new Error('Internal event metadata must not be exposed');
  const methodRes = response();
  await handler({ method: 'POST' }, methodRes);
  if (methodRes.statusCode !== 405 || methodRes.headers.Allow !== 'GET') throw new Error('API must be read-only');
  console.log('Capital behavior API tests passed: nested evidence, outcomes, metadata minimization, and GET-only access.');
} finally {
  global.fetch = originalFetch;
}
