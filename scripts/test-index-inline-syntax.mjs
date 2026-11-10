import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const blocks = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))
  .map(match => match[1].trim()).filter(Boolean);
const count = (pattern) => Array.from(html.matchAll(pattern)).length;
if (!blocks.length) throw new Error('No inline JavaScript blocks found');
blocks.forEach((source, index) => new Script(source, { filename: 'index.html:inline-' + index }));
if (count(/<script\b/gi) !== count(/<\/script\s*>/gi)) throw new Error('Script tags are unbalanced');
if (count(/<\/html\s*>/gi) !== 1 || !/<\/body>\s*<\/html>\s*$/i.test(html)) throw new Error('HTML closing tags are not unique or trailing code exists');
for (const name of ['homeChartLoad','klineFetch','klineFetchInitial','klineLoadOlder','klineCancelOlderHistory']) {
  if (count(new RegExp('\\bfunction\\s+' + name + '\\s*\\(', 'g')) !== 1) throw new Error('Expected exactly one ' + name + ' definition');
}
if (!html.includes("fetch('/api/capital-behavior'")) throw new Error('Capital behavior UI does not call the read-only API');
if (!html.includes('incremental?klineFetch(300,symbol,period,controller.signal)')) throw new Error('Incremental REST reconciliation must reload the latest 300 candles');
if (!html.includes('tideKline.chart.applyNewData(tideKline.data)')) throw new Error('REST reconciliation must render the merged/backfilled candle series');
if (!html.includes("klineLoad(true);},60000)")) throw new Error('REST reconciliation must run periodically even with an open WebSocket');
if (!html.includes('x.high>=Math.max(x.open,x.close,x.low)')) throw new Error('Candle OHLC integrity validation is missing');
if (!html.includes("['1m','5m','15m','1H','4H','1D']")) throw new Error('Supported K-line periods changed unexpectedly');
if (!html.includes('TIDE_KLINE_MIN_HISTORY=3000') || !html.includes('TIDE_KLINE_MAX_CACHE=12000')) throw new Error('K-line history or cache limits are missing');
if (!html.includes("'/api/v5/market/history-candles'") || !html.includes("'&after='+encodeURIComponent(olderThan)")) throw new Error('OKX older-history cursor must use after= with the history endpoint');
if (!html.includes('if(!data.length&&!hasOlderCursor)')) throw new Error('An empty older-history page must terminate pagination normally');
if (!html.includes("klineFetchInitial('BTC',period,ctl.signal")) throw new Error('Homepage BTC chart must backfill historical candles');
if (!html.includes('tideHomeChart.historyLoaded')) throw new Error('Homepage history loading state is missing');
if (!html.includes('klineCancelOlderHistory();tideKline.period=p;')) throw new Error('Changing timeframe must cancel older-history pagination');
if (!html.includes('if(tideKline.olderController===controller)')) throw new Error('Older-history completion must not mutate a newer request');
console.log('K-line structure and inline JavaScript checks passed: ' + blocks.length + ' script blocks.');