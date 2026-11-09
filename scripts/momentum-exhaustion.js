(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TideMomentumExhaustion = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var DEFAULTS = {
    fast: 13,
    slow: 34,
    signal: 9,
    atrPeriod: 13,
    pivotLeft: 2,
    pivotRight: 2,
    pairTolerance: 3,
    minSwingBars: 3,
    maxSwingBars: 80,
    minPriceExtensionAtr: 0.15,
    minHistogramImprovement: 0.08,
    triggerWindowBars: 6,
    activeWindowBars: 3
  };

  function ema(values, period) {
    var out = new Array(values.length).fill(null);
    if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
    var alpha = 2 / (period + 1);
    var seed = 0;
    for (var i = 0; i < period; i++) seed += Number(values[i]);
    var previous = seed / period;
    out[period - 1] = previous;
    for (var j = period; j < values.length; j++) {
      previous = Number(values[j]) * alpha + previous * (1 - alpha);
      out[j] = previous;
    }
    return out;
  }

  function macd(candles, fast, slow, signal) {
    var closes = candles.map(function (c) { return Number(c.close); });
    var fastLine = ema(closes, fast);
    var slowLine = ema(closes, slow);
    var dif = closes.map(function (_, i) {
      return fastLine[i] === null || slowLine[i] === null ? null : fastLine[i] - slowLine[i];
    });
    var first = dif.findIndex(function (v) { return v !== null; });
    var signalInput = dif.slice(first).map(function (v) { return Number(v); });
    var signalLineTail = ema(signalInput, signal);
    var signalLine = new Array(candles.length).fill(null);
    signalLineTail.forEach(function (v, i) { signalLine[first + i] = v; });
    var histogram = dif.map(function (v, i) {
      return v === null || signalLine[i] === null ? null : (v - signalLine[i]) * 2;
    });
    return { dif: dif, signal: signalLine, histogram: histogram };
  }

  function atr(candles, period) {
    var out = new Array(candles.length).fill(null);
    if (candles.length < period || period < 1) return out;
    var ranges = candles.map(function (c, i) {
      var high = Number(c.high), low = Number(c.low);
      if (i === 0) return high - low;
      var previousClose = Number(candles[i - 1].close);
      return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
    });
    var seed = 0;
    for (var i = 0; i < period; i++) seed += ranges[i];
    var value = seed / period;
    out[period - 1] = value;
    for (var j = period; j < ranges.length; j++) {
      value = ((value * (period - 1)) + ranges[j]) / period;
      out[j] = value;
    }
    return out;
  }

  function periodMs(period) {
    var map = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
      '1H': 3600000, '2H': 7200000, '4H': 14400000, '6H': 21600000, '12H': 43200000,
      '1D': 86400000, '1W': 604800000 };
    return map[period] || 900000;
  }

  function closedCandles(candles, period, now) {
    var duration = periodMs(period);
    return candles.filter(function (c) {
      return Number.isFinite(Number(c.timestamp)) && Number(c.timestamp) + duration <= now;
    });
  }

  function findPivots(values, left, right, kind) {
    var points = [];
    for (var i = left; i < values.length - right; i++) {
      var value = values[i];
      if (!Number.isFinite(value)) continue;
      var valid = true;
      for (var j = i - left; j <= i + right; j++) {
        if (j === i || !Number.isFinite(values[j])) continue;
        if (kind === 'low' ? values[j] <= value : values[j] >= value) { valid = false; break; }
      }
      if (valid) points.push({ index: i, value: value });
    }
    return points;
  }

  function pairSwings(candles, histogram, atrValues, direction, options) {
    var isLong = direction === 'long';
    var priceValues = candles.map(function (c) { return Number(isLong ? c.low : c.high); });
    var pricePivots = findPivots(priceValues, options.pivotLeft, options.pivotRight, isLong ? 'low' : 'high');
    var histPivots = findPivots(histogram, options.pivotLeft, options.pivotRight, isLong ? 'low' : 'high')
      .filter(function (p) { return isLong ? p.value < 0 : p.value > 0; });
    var used = {};
    var pairs = [];
    pricePivots.forEach(function (pricePivot) {
      var nearest = null;
      histPivots.forEach(function (histPivot) {
        var distance = Math.abs(histPivot.index - pricePivot.index);
        if (distance > options.pairTolerance || used[histPivot.index]) return;
        if (!nearest || distance < nearest.distance) nearest = { pivot: histPivot, distance: distance };
      });
      if (!nearest) return;
      used[nearest.pivot.index] = true;
      pairs.push({
        priceIndex: pricePivot.index,
        price: pricePivot.value,
        histIndex: nearest.pivot.index,
        histogram: nearest.pivot.value,
        atr: atrValues[pricePivot.index]
      });
    });
    return pairs.sort(function (a, b) { return a.priceIndex - b.priceIndex; });
  }

  function comparePair(previous, current, direction, options) {
    var isLong = direction === 'long';
    var separation = current.priceIndex - previous.priceIndex;
    if (separation < options.minSwingBars || separation > options.maxSwingBars) return false;
    var currentAtr = Number(current.atr);
    if (!Number.isFinite(currentAtr) || currentAtr <= 0) return false;
    var priceExtension = isLong ? previous.price - current.price : current.price - previous.price;
    var histImprovement = isLong ? current.histogram - previous.histogram : previous.histogram - current.histogram;
    var histBase = Math.max(Math.abs(previous.histogram), Math.abs(current.histogram), 1e-12);
    return priceExtension >= currentAtr * options.minPriceExtensionAtr &&
      histImprovement >= histBase * options.minHistogramImprovement;
  }

  function detectDivergence(candles, histogram, atrValues, direction, options) {
    var pairs = pairSwings(candles, histogram, atrValues, direction, options);
    if (pairs.length < 2) return null;
    var last = pairs[pairs.length - 1];
    var previous = pairs[pairs.length - 2];
    if (!comparePair(previous, last, direction, options)) return null;
    var third = pairs.length >= 3 ? pairs[pairs.length - 3] : null;
    var triple = Boolean(third && comparePair(third, previous, direction, options) &&
      comparePair(previous, last, direction, options));
    var confirmationIndex = Math.max(
      last.priceIndex + options.pivotRight,
      last.histIndex + options.pivotRight
    );
    return {
      direction: direction,
      swings: triple ? [third, previous, last] : [previous, last],
      divergenceCount: triple ? 3 : 2,
      confirmationIndex: confirmationIndex,
      lastPivotIndex: Math.max(last.priceIndex, last.histIndex)
    };
  }

  function findTrigger(histogram, divergence, direction, options, lastClosedIndex) {
    var isLong = direction === 'long';
    var start = divergence.confirmationIndex;
    var end = Math.min(lastClosedIndex, start + options.triggerWindowBars);
    for (var i = Math.max(2, start); i <= end; i++) {
      var a = histogram[i - 2], b = histogram[i - 1], c = histogram[i];
      if (![a, b, c].every(Number.isFinite)) continue;
      var turned = isLong ? (b <= a && c > b) : (b >= a && c < b);
      var zeroSide = isLong ? c < 0 : c > 0;
      if (turned && zeroSide) return i;
    }
    return null;
  }

  function trendBias(candles, period, now) {
    var closed = closedCandles(candles || [], period, now);
    if (closed.length < 40) return 'unavailable';
    var closes = closed.map(function (c) { return Number(c.close); });
    var fast = ema(closes, 13), slow = ema(closes, 34);
    var i = closes.length - 1;
    if (fast[i] === null || slow[i] === null) return 'unavailable';
    if (closes[i] > fast[i] && fast[i] > slow[i]) return 'up';
    if (closes[i] < fast[i] && fast[i] < slow[i]) return 'down';
    return 'neutral';
  }

  function contextAssessment(direction, period, htfBias, dailyBias) {
    var opposing = direction === 'long' ? 'down' : 'up';
    var aligned = direction === 'long' ? 'up' : 'down';
    if (period === '15m') {
      if (htfBias === 'unavailable' || dailyBias === 'unavailable') return { state: 'pending', reason: '等待完整4H与日线数据' };
      if (htfBias === opposing && dailyBias === opposing) return { state: 'blocked', reason: '4H与日线均逆向' };
      if (htfBias === aligned && dailyBias === aligned) return { state: 'aligned', reason: '4H与日线共振' };
      return { state: 'mixed', reason: '大周期尚未形成同向共振' };
    }
    if (period === '4H') {
      if (dailyBias === 'unavailable') return { state: 'pending', reason: '等待日线方向数据' };
      if (dailyBias === opposing) return { state: 'blocked', reason: '日线方向逆向' };
      if (dailyBias === aligned) return { state: 'aligned', reason: '日线方向一致' };
      return { state: 'mixed', reason: '日线方向尚不明确' };
    }
    return { state: 'context_only', reason: '该周期仅用于方向或执行参考' };
  }

  function compute(allCandles, config) {
    var cfg = Object.assign({}, DEFAULTS, config || {});
    var period = cfg.period || '15m';
    var now = Number.isFinite(cfg.now) ? cfg.now : Date.now();
    var candles = closedCandles(Array.isArray(allCandles) ? allCandles : [], period, now);
    var result = {
      status: 'insufficient',
      period: period,
      direction: null,
      divergenceCount: 0,
      triggerIndex: null,
      triggerTime: null,
      entry: null,
      atr: null,
      stop: null,
      target15: null,
      target2: null,
      risk: null,
      context: { state: 'unavailable', reason: '等待高周期数据' },
      htfBias: trendBias(cfg.htfData, '4H', now),
      dailyBias: trendBias(cfg.dailyData, '1D', now),
      closedBars: candles.length,
      message: '至少需要 80 根已收盘K线'
    };
    if (candles.length < 80) return result;

    if (period === '1D' || period === '4H') {
      var localBias = trendBias(candles, period, now);
      result.status = 'context_only';
      result.direction = localBias === 'up' ? 'long' : localBias === 'down' ? 'short' : null;
      result.message = period + ' 只提供大周期方向，不独立生成入场信号';
      result.localBias = localBias;
      return result;
    }
    if (period === '1m' || period === '3m' || period === '5m') {
      result.status = 'execution_only';
      result.message = '执行周期仅用于细化入场，必须先有15M确认信号';
      return result;
    }

    var macdResult = macd(candles, cfg.fast, cfg.slow, cfg.signal);
    var atrValues = atr(candles, cfg.atrPeriod);
    var lastIndex = candles.length - 1;
    var candidates = ['long', 'short'].map(function (direction) {
      var divergence = detectDivergence(candles, macdResult.histogram, atrValues, direction, cfg);
      if (!divergence) return null;
      var triggerIndex = findTrigger(macdResult.histogram, divergence, direction, cfg, lastIndex);
      if (triggerIndex === null) return null;
      return { divergence: divergence, triggerIndex: triggerIndex };
    }).filter(Boolean).sort(function (a, b) { return b.triggerIndex - a.triggerIndex; });

    if (!candidates.length) {
      result.status = 'watch';
      result.message = '暂无满足条件的连续背离与收盘触发';
      result.macd = macdResult;
      return result;
    }

    var candidate = candidates[0];
    var divergence = candidate.divergence;
    var triggerIndex = candidate.triggerIndex;
    var trigger = candles[triggerIndex];
    var riskAtr = atrValues[triggerIndex];
    var isLong = divergence.direction === 'long';
    var entry = Number(trigger.close);
    var stop = isLong ? Number(trigger.low) - riskAtr : Number(trigger.high) + riskAtr;
    var risk = Math.abs(entry - stop);
    var ageBars = lastIndex - triggerIndex;
    var context = contextAssessment(divergence.direction, period, result.htfBias, result.dailyBias);
    result.status = context.state === 'blocked' ? 'blocked' :
      context.state === 'pending' ? 'context_pending' :
      context.state !== 'aligned' ? 'context_mixed' :
      ageBars <= cfg.activeWindowBars ? 'triggered' : 'expired';
    result.direction = divergence.direction;
    result.divergenceCount = divergence.divergenceCount;
    result.triggerIndex = triggerIndex;
    result.triggerTime = Number(trigger.timestamp);
    result.ageBars = ageBars;
    result.context = context;
    result.swings = divergence.swings;
    if (result.status === 'triggered') {
      result.entry = entry;
      result.atr = riskAtr;
      result.stop = stop;
      result.risk = risk;
      result.target15 = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
      result.target2 = isLong ? entry + risk * 2 : entry - risk * 2;
    }
    result.message = result.status === 'blocked' ? '背离成立，但4H与日线方向均冲突，禁止作为交易信号' :
      result.status === 'context_pending' ? '背离形态出现，等待完整高周期数据' :
      result.status === 'context_mixed' ? '背离形态出现，但大周期未共振，仅作观察' :
      result.status === 'expired' ? '背离触发已过期，仅保留历史标记' :
      (isLong ? '底背离' : '顶背离') + ' · ' + divergence.divergenceCount + '段 · 收盘触发';
    return result;
  }

  function formatPrice(value) {
    if (!Number.isFinite(Number(value))) return '—';
    var n = Number(value);
    return n < 1 ? n.toFixed(6) : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function render(result, language) {
    if (typeof document === 'undefined') return;
    var en = language === 'en';
    var set = function (id, value) {
      var el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    var status = result.status;
    var label = status === 'insufficient' ? (en ? 'Waiting for candles' : '等待足够K线') :
      status === 'triggered' ? (en ? 'Confirmed 15M setup' : '15M收盘触发') :
      status === 'blocked' ? (en ? 'Blocked by higher timeframe' : '大周期拦截') :
      status === 'context_pending' ? (en ? 'Waiting for higher-timeframe data' : '等待高周期数据') :
      status === 'context_mixed' ? (en ? 'Higher timeframes not aligned' : '大周期未共振') :
      status === 'context_only' ? (en ? 'Direction context only' : '方向参考，不独立入场') :
      status === 'execution_only' ? (en ? 'Execution only · wait for 15M' : '仅执行周期 · 等待15M确认') :
      status === 'expired' ? (en ? 'Expired trigger' : '触发已过期') :
      (en ? 'No confirmed divergence' : '暂无有效背离');
    var side = result.direction ? (result.direction === 'long' ? (en ? 'LONG' : '做多') : (en ? 'SHORT' : '做空')) : '—';
    var divergence = result.divergenceCount ? (en ? result.divergenceCount + '-swing divergence' : result.divergenceCount + '段连续背离') : '—';
    var context = result.context && result.context.reason ? result.context.reason : '—';
    if (en && result.context) {
      context = ({ aligned: 'Higher-timeframe aligned', caution: 'Countertrend risk', mixed: 'Mixed higher-timeframe bias',
        blocked: 'Blocked by higher-timeframe bias', pending: 'Waiting for higher-timeframe data', context_only: 'Context only', unavailable: 'Waiting for context data' })[result.context.state] || context;
    }
    set('momentum-label-status', en ? 'Momentum exhaustion' : '动能衰竭');
    set('momentum-value-status', label);
    set('momentum-value-side', side + (result.divergenceCount ? ' · ' + divergence : ''));
    set('momentum-value-context', context);
    set('momentum-value-risk', result.entry !== null ?
      (en ? 'Entry ' : '入场 ') + formatPrice(result.entry) + ' / ' + (en ? 'Stop ' : '止损 ') + formatPrice(result.stop) :
      (en ? 'Waiting for a closed-bar trigger' : result.message));
    set('momentum-value-target', result.target15 !== null ?
      '1.5R ' + formatPrice(result.target15) + ' · 2R ' + formatPrice(result.target2) : '—');
    var panel = document.getElementById('tide-momentum-panel');
    if (panel) panel.setAttribute('data-state', status);
  }

  return {
    defaults: DEFAULTS,
    ema: ema,
    macd: macd,
    atr: atr,
    findPivots: findPivots,
    trendBias: trendBias,
    comparePair: comparePair,
    detectDivergence: detectDivergence,
    findTrigger: findTrigger,
    contextAssessment: contextAssessment,
    compute: compute,
    render: render
  };
});
