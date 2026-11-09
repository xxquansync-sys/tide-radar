const BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const iso = value => new Date(value).toISOString();
const MIN_HORIZON_MS = 60 * 60000;
const MAX_TARGET_MS = 90 * 60000;
const BASELINE_LOOKBACK_MS = 60 * 60000;
const PRICE_THRESHOLD_PCT = 0.15;
const OI_MATERIAL_CHANGE_THRESHOLD_PCT = 0.5;

async function db(table, query, options = {}) {
  const response = await fetch(BASE + '/rest/v1/' + table + (query ? '?' + query : ''), {
    method: options.method || 'GET',
    headers: {
      apikey: KEY, Authorization: 'Bearer ' + KEY, Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.prefer ? { Prefer: options.prefer } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const body = await response.text();
  if (!response.ok) throw new Error(table + ' HTTP ' + response.status + ': ' + body.slice(0, 300));
  return body ? JSON.parse(body) : [];
}

function metricRows(observations, marketType, metric) {
  return observations.filter(row => row.market_type === marketType && row.metric === metric &&
    Number.isFinite(Number(row.metric_value)) && row.data_quality === 'observed')
    .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
}

function closestBefore(rows, timestamp, maxAgeMs) {
  const matches = rows.filter(row => {
    const time = Date.parse(row.observed_at);
    return time <= timestamp && timestamp - time <= maxAgeMs;
  });
  return matches.length ? matches[matches.length - 1] : null;
}

function firstAfter(rows, timestamp, minOffsetMs, maxOffsetMs) {
  const min = timestamp + minOffsetMs, max = timestamp + maxOffsetMs;
  return rows.find(row => {
    const time = Date.parse(row.observed_at);
    return time >= min && time <= max;
  }) || null;
}

function priceDirection(changePct, threshold = PRICE_THRESHOLD_PCT) {
  if (!Number.isFinite(changePct) || Math.abs(changePct) < threshold) return 'neutral';
  return changePct > 0 ? 'buy' : 'sell';
}

function analyzeEvent(event, observations, flows, outcomes = [], now = Date.now()) {
  const start = Date.parse(event.started_at);
  if (!Number.isFinite(start) || now < start + MIN_HORIZON_MS) return { ready: false, evidence: [], promotion: null };
  const spot = metricRows(observations, 'spot', 'last_price');
  const oi = metricRows(observations, 'swap', 'open_interest_usd');
  const funding = metricRows(observations, 'swap', 'funding_rate');
  const basis = metricRows(observations, 'aggregate', 'spot_swap_basis_pct');
  const oiBefore = closestBefore(oi, start, BASELINE_LOOKBACK_MS);
  const oiAfter = firstAfter(oi, start, MIN_HORIZON_MS, MAX_TARGET_MS);
  const contextAt = start + MIN_HORIZON_MS;
  const fundingRow = closestBefore(funding, contextAt + 10 * 60000, 40 * 60000) ||
    firstAfter(funding, start, MIN_HORIZON_MS, MAX_TARGET_MS);
  const basisRow = closestBefore(basis, contextAt + 10 * 60000, 40 * 60000) ||
    firstAfter(basis, start, MIN_HORIZON_MS, MAX_TARGET_MS);

  const evidence = [];
  const validOutcomes = outcomes.filter(row => row.evaluation_status === 'complete' &&
    row.data_quality === 'complete' && Number.isFinite(Number(row.return_pct)));
  const outcome15 = validOutcomes.find(row => Number(row.horizon_minutes) === 15);
  const outcome60 = validOutcomes.find(row => Number(row.horizon_minutes) === 60);
  let priceAligned = false, oiMaterialChange = false, priceChangePct = null, price15mPct = null, oiDeltaPct = null;

  [outcome15, outcome60].filter(Boolean).forEach(outcome => {
    const horizon = Number(outcome.horizon_minutes);
    const change = Number(outcome.return_pct);
    const direction = priceDirection(change);
    const aligned = direction === event.direction;
    if (horizon === 15) price15mPct = change;
    if (horizon === 60) { priceChangePct = change; priceAligned = aligned; }
    evidence.push({
      event_id: event.id, evidence_type: 'price_response',
      source: 'OKX candle outcome · ' + horizon + 'm horizon',
      observed_at: outcome.evaluated_at || iso(start + horizon * 60000),
      window_seconds: horizon * 60, direction, evidence_state: 'observed',
      metrics: {
        return_pct: change, horizon_minutes: horizon, event_direction: event.direction,
        direction_aligned: aligned,
        max_favorable_excursion_pct: outcome.max_favorable_excursion_pct === null ? null : Number(outcome.max_favorable_excursion_pct),
        max_adverse_excursion_pct: outcome.max_adverse_excursion_pct === null ? null : Number(outcome.max_adverse_excursion_pct)
      },
      explanation: aligned ?
        horizon + '分钟价格变化与主动成交方向一致。该结果是价格响应，不等于账户净持仓或策略收益。' :
        direction === 'neutral' ?
          horizon + '分钟价格变化未达到方向阈值，暂未形成明确跟随。' :
          horizon + '分钟价格变化与主动成交方向相反，记为冲突证据。'
    });
  });

  if (!outcome60) {
    const priceBefore = closestBefore(spot, start, BASELINE_LOOKBACK_MS);
    const priceAfter = firstAfter(spot, start, MIN_HORIZON_MS, MAX_TARGET_MS);
    if (priceBefore && priceAfter) {
      const before = Number(priceBefore.metric_value), after = Number(priceAfter.metric_value);
      priceChangePct = before > 0 ? (after / before - 1) * 100 : null;
      const direction = priceDirection(priceChangePct);
      priceAligned = direction === event.direction;
      evidence.push({
        event_id: event.id, evidence_type: 'price_response',
        source: 'OKX spot observations · 60–90m follow-through',
        observed_at: priceAfter.observed_at,
        window_seconds: Math.max(1, Math.round((Date.parse(priceAfter.observed_at) - start) / 1000)),
        direction, evidence_state: 'observed',
        metrics: { baseline_price: before, follow_through_price: after, return_pct: priceChangePct,
          event_direction: event.direction, direction_aligned: priceAligned,
          observed_horizon_minutes: Math.round((Date.parse(priceAfter.observed_at) - start) / 60000) },
        explanation: priceAligned ? '60–90分钟现货价格响应与事件方向一致。' :
          direction === 'neutral' ? '60–90分钟现货价格变化未达到方向阈值。' :
            '60–90分钟现货价格方向与主动成交方向相反。'
      });
    } else if (now >= start + MAX_TARGET_MS) {
      evidence.push({
        event_id: event.id, evidence_type: 'price_response',
        source: 'OKX spot observations · 60–90m follow-through',
        observed_at: iso(start + MIN_HORIZON_MS), window_seconds: 3600,
        direction: 'neutral', evidence_state: 'missing',
        metrics: { event_direction: event.direction, reason: 'No complete 60–90m spot follow-through pair' },
        explanation: '缺少完整60–90分钟现货观测，不能用其他时间尺度替代。'
      });
    }
  }

  if (oiBefore && oiAfter) {
    const before = Number(oiBefore.metric_value), after = Number(oiAfter.metric_value);
    oiDeltaPct = before > 0 ? (after / before - 1) * 100 : null;
    oiMaterialChange = Number.isFinite(oiDeltaPct) && Math.abs(oiDeltaPct) >= OI_MATERIAL_CHANGE_THRESHOLD_PCT;
    evidence.push({
      event_id: event.id, evidence_type: 'open_interest',
      source: 'OKX swap open-interest observations · 60–90m window',
      observed_at: oiAfter.observed_at, window_seconds: Math.max(1, Math.round((Date.parse(oiAfter.observed_at) - start) / 1000)),
      direction: 'neutral', evidence_state: 'observed',
      metrics: { open_interest_before_usd: before, open_interest_after_usd: after,
        delta_pct: oiDeltaPct, material_change_threshold_pct: OI_MATERIAL_CHANGE_THRESHOLD_PCT,
        interpretation: 'aggregate_open_interest_is_not_directional' },
      explanation: oiDeltaPct >= OI_MATERIAL_CHANGE_THRESHOLD_PCT ?
        '60–90分钟内未平仓合约名义价值增加，说明总风险敞口扩张；OI本身不区分新增多头与新增空头。' :
        oiDeltaPct <= -OI_MATERIAL_CHANGE_THRESHOLD_PCT ?
          '60–90分钟内未平仓合约名义价值下降，说明总风险敞口收缩，可能涉及去杠杆或平仓；不能据此判断是哪一侧账户在平仓。' :
          '60–90分钟内未平仓合约名义价值变化较小，暂不构成明显持仓扩张或收缩证据。'
    });
  } else if (now >= start + MAX_TARGET_MS) {
    evidence.push({
      event_id: event.id, evidence_type: 'open_interest',
      source: 'OKX swap open-interest observations · 60–90m window',
      observed_at: iso(start + MIN_HORIZON_MS), window_seconds: 3600,
      direction: 'neutral', evidence_state: 'missing',
      metrics: { reason: 'No observed 60–90m open-interest pair' },
      explanation: '缺少完整60–90分钟OI观测，不将单点OI数值解释为持仓变化。'
    });
  }

  const windowStart = start - 15 * 60000, windowEnd = start + 90 * 60000;
  const matchingFlows = flows.filter(flow => {
    const occurred = Date.parse(flow.occurred_at);
    const pending = flow.metadata && (flow.metadata.pending === true || flow.metadata.pending === 'true');
    return occurred >= windowStart && occurred <= windowEnd && flow.block_height !== null &&
      flow.block_height !== undefined && !pending && ['exchange_inflow', 'exchange_outflow'].includes(flow.flow_type);
  });
  const inflowUsd = matchingFlows.filter(x => x.flow_type === 'exchange_inflow').reduce((sum, x) => sum + (Number(x.usd_value) || 0), 0);
  const outflowUsd = matchingFlows.filter(x => x.flow_type === 'exchange_outflow').reduce((sum, x) => sum + (Number(x.usd_value) || 0), 0);
  const pendingFlows = flows.filter(flow => {
    const occurred = Date.parse(flow.occurred_at);
    return occurred >= windowStart && occurred <= windowEnd &&
      (flow.block_height === null || flow.block_height === undefined ||
        (flow.metadata && (flow.metadata.pending === true || flow.metadata.pending === 'true')));
  });
  const contextMetrics = {
    funding_rate: fundingRow ? Number(fundingRow.metric_value) : null,
    funding_observed_at: fundingRow ? fundingRow.observed_at : null,
    spot_swap_basis_pct: basisRow ? Number(basisRow.metric_value) : null,
    basis_observed_at: basisRow ? basisRow.observed_at : null,
    confirmed_exchange_wallet_flows: matchingFlows.length,
    confirmed_exchange_inflow_usd: inflowUsd,
    confirmed_exchange_outflow_usd: outflowUsd,
    excluded_unconfirmed_flow_rows: pendingFlows.length,
    attribution_scope: 'published_exchange_wallet_sample_only',
    reserve_trend_available: false
  };
  evidence.push({
    event_id: event.id, evidence_type: 'other',
    source: 'OKX funding/basis and confirmed public PoR wallet sample',
    observed_at: iso(start + MIN_HORIZON_MS), window_seconds: 5400,
    direction: 'neutral', evidence_state: fundingRow || basisRow || matchingFlows.length ? 'observed' : 'missing',
    metrics: contextMetrics,
    explanation: '资金费率与现货/永续基差仅作拥挤度背景；链上仅纳入已确认的交易所公开钱包样本。钱包流入不等于卖出，流出不等于买入；该样本不代表交易所完整储备或全部链上流量。当前每个资产只有一个PoR快照，不能计算储备趋势。'
  });

  const promotion = event.event_type === 'aggressive_execution' &&
    ['buy', 'sell'].includes(event.direction) && priceAligned && oiMaterialChange ? 'medium' : null;
  return { ready: true, evidence, promotion, priceChangePct, price15mPct, oiDeltaPct, matchingFlowCount: matchingFlows.length };
}

function evidenceKey(row) {
  return [row.evidence_type, row.source, row.observed_at].join('|');
}

async function processEvent(event, observations, flows, now, existingByEvent, outcomesByEvent) {
  const analysis = analyzeEvent(event, observations, flows, outcomesByEvent.get(event.id) || [], now);
  if (!analysis.ready || !analysis.evidence.length) return { eventKey: event.event_key, status: 'waiting' };
  const existing = existingByEvent.get(event.id) || [];
  const seen = new Set(existing.map(evidenceKey));
  const fresh = analysis.evidence.filter(row => !seen.has(evidenceKey(row)));
  if (fresh.length) {
    await db('capital_behavior_evidence', '', { method: 'POST', body: fresh, prefer: 'return=minimal' });
    existingByEvent.set(event.id, existing.concat(fresh));
  }
  let promoted = false;
  if (analysis.promotion === 'medium' && event.status === 'forming' && event.evidence_strength !== 'strong') {
    await db('capital_behavior_events', 'id=eq.' + encodeURIComponent(event.id), {
      method: 'PATCH', body: { evidence_strength: 'medium', status: 'confirmed' }, prefer: 'return=minimal'
    });
    promoted = true;
  }
  return { eventKey: event.event_key, status: promoted ? 'medium' : 'observed',
    evidenceAdded: fresh.length, priceChangePct: analysis.priceChangePct, oiDeltaPct: analysis.oiDeltaPct,
    eligibleChainFlows: analysis.matchingFlowCount };
}

async function main() {
  if (!BASE || !KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  const now = Date.now(), cutoff = iso(now - 6 * 3600000);
  const events = await db('capital_behavior_events',
    'select=id,event_key,symbol,event_type,direction,evidence_strength,status,started_at&started_at=gte.' +
    encodeURIComponent(cutoff) + '&order=started_at.desc&limit=100');
  const eligible = events.filter(event => event.event_type === 'aggressive_execution' &&
    ['buy', 'sell'].includes(event.direction));
  const results = [];
  for (const symbol of Array.from(new Set(eligible.map(event => event.symbol)))) {
    const observations = await db('capital_market_observations',
      'select=asset,market_type,metric,metric_value,unit,observed_at,data_quality,source&asset=eq.' +
      encodeURIComponent(symbol) + '&observed_at=gte.' + encodeURIComponent(iso(now - 8 * 3600000)) +
      '&order=observed_at.asc&limit=1500');
    const network = symbol === 'BTC' ? 'BTC' : symbol === 'ETH' ? 'ETH' : null;
    const flows = network ? await db('capital_flows',
      'select=asset,flow_type,usd_value,block_height,occurred_at,observed_at,metadata&network=eq.' +
      network + '&occurred_at=gte.' + encodeURIComponent(iso(now - 8 * 3600000)) +
      '&order=occurred_at.asc&limit=2000') : [];
    const symbolEvents = eligible.filter(item => item.symbol === symbol);
    const eventIds = symbolEvents.map(event => event.id);
    const evidenceRows = eventIds.length ? await db('capital_behavior_evidence',
      'select=event_id,evidence_type,source,observed_at&event_id=' +
      encodeURIComponent('in.(' + eventIds.join(',') + ')') + '&limit=2000') : [];
    const existingByEvent = new Map();
    evidenceRows.forEach(row => {
      const list = existingByEvent.get(row.event_id) || [];
      list.push(row);
      existingByEvent.set(row.event_id, list);
    });
    const outcomeRows = eventIds.length ? await db('capital_behavior_outcomes',
      'select=event_id,horizon_minutes,return_pct,max_favorable_excursion_pct,max_adverse_excursion_pct,evaluation_status,data_quality,evaluated_at&event_id=' +
      encodeURIComponent('in.(' + eventIds.join(',') + ')') + '&evaluation_status=eq.complete&data_quality=eq.complete&limit=500') : [];
    const outcomesByEvent = new Map();
    outcomeRows.forEach(row => {
      const list = outcomesByEvent.get(row.event_id) || [];
      list.push(row);
      outcomesByEvent.set(row.event_id, list);
    });
    for (const event of symbolEvents) {
      try { results.push(await processEvent(event, observations, flows, now, existingByEvent, outcomesByEvent)); }
      catch (error) { results.push({ eventKey: event.event_key, status: 'error', error: String(error.message || error).slice(0, 180) }); }
    }
  }
  console.log(JSON.stringify({ events: eligible.length, results }));
}

function test() {
  const start = Date.parse('2026-11-10T00:00:00Z');
  const now = start + 90 * 60000;
  const event = { id: 'event-1', event_key: 'ETH:aggressive_execution:buy:test', symbol: 'ETH',
    event_type: 'aggressive_execution', direction: 'buy', evidence_strength: 'weak',
    status: 'forming', started_at: iso(start) };
  const observations = [
    { market_type: 'spot', metric: 'last_price', metric_value: 3000, observed_at: iso(start - 600000), data_quality: 'observed' },
    { market_type: 'spot', metric: 'last_price', metric_value: 3010, observed_at: iso(start + 60 * 60000), data_quality: 'observed' },
    { market_type: 'swap', metric: 'open_interest_usd', metric_value: 100000000, observed_at: iso(start - 600000), data_quality: 'observed' },
    { market_type: 'swap', metric: 'open_interest_usd', metric_value: 101000000, observed_at: iso(start + 60 * 60000), data_quality: 'observed' },
    { market_type: 'swap', metric: 'funding_rate', metric_value: 0.0001, observed_at: iso(start + 60 * 60000), data_quality: 'observed' },
    { market_type: 'aggregate', metric: 'spot_swap_basis_pct', metric_value: 0.03, observed_at: iso(start + 60 * 60000), data_quality: 'estimated' }
  ];
  const outcomes = [
    { event_id: 'event-1', horizon_minutes: 15, return_pct: 0.1, max_favorable_excursion_pct: 0.2,
      max_adverse_excursion_pct: -0.1, evaluation_status: 'complete', data_quality: 'complete', evaluated_at: iso(start + 20 * 60000) },
    { event_id: 'event-1', horizon_minutes: 60, return_pct: 0.4, max_favorable_excursion_pct: 0.6,
      max_adverse_excursion_pct: -0.2, evaluation_status: 'complete', data_quality: 'complete', evaluated_at: iso(start + 60 * 60000) }
  ];
  const flows = [
    { flow_type: 'exchange_inflow', usd_value: 100000, block_height: 200, occurred_at: iso(start + 300000),
      metadata: { pending: false } },
    { flow_type: 'exchange_inflow', usd_value: 50000, block_height: null, occurred_at: iso(start + 300000),
      metadata: { pending: true } }
  ];
  const result = analyzeEvent(event, observations, flows, outcomes, now);
  if (!result.ready || result.promotion !== 'medium' || result.priceChangePct !== 0.4 ||
      result.oiDeltaPct < 0.5 || result.matchingFlowCount !== 1) throw new Error('Aligned 60m cross-source promotion test failed');
  const oiEvidence = result.evidence.find(row => row.evidence_type === 'open_interest');
  if (!oiEvidence || oiEvidence.direction !== 'neutral') throw new Error('Open interest must remain non-directional evidence');
  const contextEvidence = result.evidence.find(row => row.evidence_type === 'other');
  if (!contextEvidence || contextEvidence.metrics.reserve_trend_available !== false ||
      contextEvidence.metrics.spot_swap_basis_pct !== null) throw new Error('Reserve/basis quality guard failed');
  const fifteenMinute = result.evidence.find(row => row.evidence_type === 'price_response' && row.metrics.horizon_minutes === 15);
  if (!fifteenMinute || fifteenMinute.direction !== 'neutral') throw new Error('15m price response threshold failed');
  const estimatedOnly = analyzeEvent(event, observations.map(row => ({ ...row, data_quality: 'estimated' })), flows, outcomes, now);
  if (estimatedOnly.promotion !== null) throw new Error('Estimated market observations must not promote events');
  const conflicting = analyzeEvent({ ...event, direction: 'sell' }, observations, flows, outcomes, now);
  if (conflicting.promotion !== null) throw new Error('Conflicting 60m price response must not promote event');
  const contractionObservations = observations.map(row => row.metric === 'open_interest_usd' && Date.parse(row.observed_at) > start ?
    { ...row, metric_value: 99000000 } : row);
  const contraction = analyzeEvent({ ...event, direction: 'sell' }, contractionObservations, flows,
    outcomes.map(row => row.horizon_minutes === 60 ? { ...row, return_pct: -0.4 } : row), now);
  if (contraction.promotion !== 'medium' || !contraction.evidence.find(row => row.evidence_type === 'open_interest').explanation.includes('风险敞口收缩')) {
    throw new Error('Aligned price follow-through plus OI contraction should confirm a deleveraging context, not imply new shorts');
  }
  const flatOi = analyzeEvent(event, observations.map(row => row.metric === 'open_interest_usd' && Date.parse(row.observed_at) > start ?
    { ...row, metric_value: 100100000 } : row), flows, outcomes, now);
  if (flatOi.promotion !== null) throw new Error('Small OI changes must not promote an event');
  const noLookahead = analyzeEvent(event, observations, flows, outcomes, start + 30 * 60000);
  if (noLookahead.ready) throw new Error('Events younger than 60m must not be evaluated');
  const excluded = analyzeEvent(event, observations, flows.filter(x => x.block_height === null), outcomes, now);
  if (excluded.matchingFlowCount !== 0) throw new Error('Unconfirmed chain flows must be excluded');
  console.log('Capital correlation tests passed: 15m/60m candle outcomes, 60–90m OI alignment, OI neutrality, estimated-data guard, and confirmed chain-flow filter.');
}

if (process.env.TIDE_CAPITAL_CORRELATION_TEST === '1') test();
else main().catch(error => { console.error(error); process.exitCode = 1; });
