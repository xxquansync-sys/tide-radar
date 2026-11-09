import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const blocks = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))
  .map(match => match[1].trim()).filter(Boolean);
if (!blocks.length) throw new Error('No inline JavaScript blocks found');
blocks.forEach((source, index) => new Script(source, { filename: 'index.html:inline-' + index }));
if (!html.includes("fetch('/api/capital-behavior'")) throw new Error('Capital behavior UI does not call the read-only API');
if (!html.includes('incremental?klineFetch(300,symbol,period,controller.signal)')) throw new Error('Incremental REST reconciliation must reload the latest 300 candles');
if (!html.includes('tideKline.chart.applyNewData(tideKline.data)')) throw new Error('REST reconciliation must render the merged/backfilled candle series');
if (!html.includes("klineLoad(true);},60000)")) throw new Error('REST reconciliation must run periodically even with an open WebSocket');
if (!html.includes('x.high>=Math.max(x.open,x.close,x.low)')) throw new Error('Candle OHLC integrity validation is missing');
console.log('Index inline JavaScript syntax passed: ' + blocks.length + ' script blocks.');
