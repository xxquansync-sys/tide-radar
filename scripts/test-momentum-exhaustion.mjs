import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { compute, ema, macd, atr, findPivots, comparePair, findTrigger, contextAssessment, trendBias } = require('./momentum-exhaustion.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const values = Array.from({ length: 50 }, (_, i) => i + 1);
const e = ema(values, 13);
assert(e.length === 50 && e[11] === null && Number.isFinite(e[12]), 'EMA seed alignment failed');

const candles = Array.from({ length: 180 }, (_, i) => {
  const close = 100 + Math.sin(i / 6) * 3 + i * 0.015;
  return { timestamp: 1790000000000 + i * 900000, open: close - 0.3, high: close + 1, low: close - 1, close, volume: 100 + i };
});
const m = macd(candles, 13, 34, 9);
assert(m.histogram.length === candles.length && m.histogram.some(Number.isFinite), 'MACD 13/34/9 calculation failed');
const a = atr(candles, 13);
assert(a.length === candles.length && a.slice(12).every(Number.isFinite), 'ATR(13) calculation failed');
assert(findPivots([5,4,3,4,5],2,2,'low').length === 1, 'Confirmed pivot detection failed');

const now = candles[candles.length - 1].timestamp + 900000;
const insufficient = compute(candles.slice(0, 50), { period: '15m', now });
assert(insufficient.status === 'insufficient', 'Insufficient candle guard failed');

const closed = candles.slice(0, -1);
const currentNow = closed[closed.length - 1].timestamp + 900000;
const noLookahead = compute(candles, { period: '15m', now: currentNow });
assert(noLookahead.closedBars === closed.length, 'Unclosed candle must be excluded');

const daily = Array.from({ length: 80 }, (_, i) => {
  const close = 200 - i * 0.8;
  return { timestamp: 1790000000000 + i * 86400000, open: close + 0.3, high: close + 1, low: close - 1, close };
});
const dailyBias = trendBias(daily, '1D', daily[daily.length - 1].timestamp + 86400000);
assert(dailyBias === 'down', 'Daily EMA trend context failed');
const dailyOnly = compute(daily, { period: '1D', now: daily[daily.length - 1].timestamp + 86400000 });
assert(dailyOnly.status === 'context_only' && dailyOnly.direction === 'short', 'Daily must remain context-only');
const executionOnly = compute(candles, { period: '5m', now });
assert(executionOnly.status === 'execution_only', '5m must not create standalone signals');

const options = require('./momentum-exhaustion.js').defaults;
assert(comparePair({ priceIndex: 10, price: 100, histogram: -3, atr: 2 },
  { priceIndex: 20, price: 99, histogram: -2.5, atr: 2 }, 'long', options),
  'Bullish divergence threshold failed');
assert(!comparePair({ priceIndex: 10, price: 100, histogram: -3, atr: 2 },
  { priceIndex: 20, price: 101, histogram: -2.5, atr: 2 }, 'long', options),
  'Bullish divergence must require a lower price low');
assert(comparePair({ priceIndex: 10, price: 100, histogram: 3, atr: 2 },
  { priceIndex: 20, price: 101, histogram: 2.5, atr: 2 }, 'short', options),
  'Bearish divergence threshold failed');
assert(findTrigger([-1, -2, -3, -2.5], { confirmationIndex: 3 }, 'long', options, 3) === 3,
  'First closed bullish histogram turn failed');
assert(findTrigger([1, 2, 3, 2.5], { confirmationIndex: 3 }, 'short', options, 3) === 3,
  'First closed bearish histogram turn failed');
assert(contextAssessment('long', '15m', 'up', 'up').state === 'aligned',
  '15m requires 4H and daily resonance');
assert(contextAssessment('long', '15m', 'down', 'down').state === 'blocked',
  'Opposing 4H and daily trends must block the setup');
assert(contextAssessment('long', '15m', 'unavailable', 'up').state === 'pending',
  'Missing higher-timeframe data must not create a signal');


console.log('Momentum exhaustion tests passed: EMA, MACD 13/34/9, ATR(13), confirmed pivots, closed-bar guard, and higher-timeframe bias.');
