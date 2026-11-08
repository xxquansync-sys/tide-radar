import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const SYMBOLS = ['BTC-USDT-SWAP','ETH-USDT-SWAP','WLD-USDT-SWAP'];
const DAYS = 180;
const FEE_PER_SIDE = 0.0005;
const MAX_HOLD_BARS = 96;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requestQueue = Promise.resolve(), lastRequestAt = 0;
function okxFetch(url) {
  const task = requestQueue.then(async () => {
    const wait = Math.max(0, 150 - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
    let error;
    for (let attempt=0; attempt<3; attempt++) {
      try {
        const response = await fetch(url, { headers: { 'User-Agent': 'TIDELINE-historical-replay/1.0' }, signal: AbortSignal.timeout(15000) });
        if (response.status === 429 || response.status >= 500) throw new Error('temporary OKX HTTP ' + response.status);
        return response;
      } catch (e) { error=e; await sleep(500*(attempt+1)); }
    }
    throw error || new Error('OKX request failed');
  });
  requestQueue = task.catch(() => {});
  return task;
}

async function candles(instId, bar, days) {
  const since = Date.now() - days * 86400000;
  let after, all = [], lastOldest = Infinity;
  for (let page = 0; page < 500; page++) {
    const u = new URL('https://www.okx.com/api/v5/market/history-candles');
    u.searchParams.set('instId', instId);
    u.searchParams.set('bar', bar);
    u.searchParams.set('limit', '100');
    if (after) u.searchParams.set('after', String(after));
    const res = await okxFetch(u);
    if (!res.ok) throw new Error(`OKX HTTP ${res.status}: ${instId} ${bar}`);
    const json = await res.json();
    if (json.code !== '0') throw new Error(`OKX API ${json.code}: ${json.msg}`);
    const rows = json.data || [];
    if (!rows.length) break;
    all.push(...rows);
    const oldest = Math.min(...rows.map(x => Number(x[0])));
    if (oldest <= since || oldest >= lastOldest) break;
    lastOldest = oldest;
    after = oldest;
    if (page % 20 === 0) console.log('Fetched', instId, bar, 'page', page + 1);
  }
  const unique = new Map();
  for (const x of all) {
    const ts = Number(x[0]);
    if (ts < since) continue;
    unique.set(ts, {
      timestamp: ts, open: +x[1], high: +x[2], low: +x[3],
      close: +x[4], volume: +x[5], confirmed: x[8] === '1'
    });
  }
  return [...unique.values()].sort((a,b) => a.timestamp-b.timestamp);
}

function loadEngine(source) {
  const context = { window: {} };
  vm.runInNewContext(source, context, { timeout: 10000 });
  return context.window.TideTdxStructure;
}

function summarizeTrades(trades) {
  const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<=0);
  const grossWin=wins.reduce((a,t)=>a+t.netR,0),grossLoss=Math.abs(losses.reduce((a,t)=>a+t.netR,0));
  let equity=0,peak=0,maxDd=0;
  for(const t of trades){equity+=t.netR;peak=Math.max(peak,equity);maxDd=Math.max(maxDd,peak-equity);}
  return {
    trades:trades.length,winRate:trades.length?wins.length/trades.length:0,
    avgR:trades.length?trades.reduce((a,t)=>a+t.netR,0)/trades.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:(grossWin?null:0),
    netR:trades.reduce((a,t)=>a+t.netR,0),maxDrawdownR:maxDd,
    stopRate:trades.length?trades.filter(t=>t.reason==='stop').length/trades.length:0,
    targetRate:trades.length?trades.filter(t=>t.reason==='target').length/trades.length:0,
    timeExitRate:trades.length?trades.filter(t=>t.reason==='time').length/trades.length:0
  };
}
function publicStats(result) { const { _trades, ...stats } = result; return stats; }
function simulate(data, signals, windowEnd=data.length-1) {
  const sorted = [...signals].sort((a,b) => a.index-b.index);
  const trades = [];
  let lockedUntil = -1;
  for (const s of sorted) {
    if (s.index <= lockedUntil) continue;
    const entryBar = data[s.index + 1];
    if (!entryBar || s.index+1>windowEnd) continue;
    const dir = s.direction === 'long' ? 1 : -1;
    const entry = entryBar.open;
    const stop = s.stop, target = s.target;
    const risk = Math.abs(entry-stop);
    if (!Number.isFinite(risk) || risk <= 0 || !Number.isFinite(target)) continue;
    let exit = null, reason = 'time';
    const end = Math.min(windowEnd, data.length-1, s.index + 1 + MAX_HOLD_BARS);
    for (let i=s.index+1; i<=end; i++) {
      const c=data[i], stopHit=dir===1?c.low<=stop:c.high>=stop;
      const targetHit=dir===1?c.high>=target:c.low<=target;
      if (stopHit) { exit = (i===s.index+1 && (dir===1?c.open<stop:c.open>stop)) ? c.open : stop; reason='stop'; lockedUntil=i; break; }
      if (targetHit) { exit = (i===s.index+1 && (dir===1?c.open>target:c.open<target)) ? c.open : target; reason='target'; lockedUntil=i; break; }
      if (i===end) { exit=c.close; lockedUntil=i; }
    }
    if (exit===null) continue;
    const gross=(exit-entry)*dir;
    const fees=(entry+exit)*FEE_PER_SIDE;
    const netR=(gross-fees)/risk;
    trades.push({index:s.index,dir,entry,exit,reason,netR,score:s.score||0,alignment:s.alignment||'legacy',maTrend:s.maTrend||'neutral',maCross:s.maCross||'none'});
  }
  return Object.assign(summarizeTrades(trades),{_trades:trades});
}
const current = loadEngine(readFileSync('tdx-structure.js','utf8'));
const oldSource = execFileSync('git',['show','4fbcb85b6fd2c7c26db1402ed896541bb391b668:tdx-structure.js'],{encoding:'utf8'});
const legacy = loadEngine(oldSource);
const results = [];
for (const instId of SYMBOLS) {
  const [m15,h4,d1] = await Promise.all([
    candles(instId,'15m',DAYS), candles(instId,'4H',DAYS), candles(instId,'1D',DAYS)
  ]);
  const old = legacy.computeMultiTimeframe(m15,h4,d1,{},'15m');
  const fresh = current.computeMultiTimeframe(m15,h4,d1,{},'15m');
  const oldRun = simulate(m15,old.signals.filter(s=>s.tradable));
  const newRun = simulate(m15,fresh.signals);
  const new60 = simulate(m15,fresh.signals.filter(s=>s.score>=60));
  const new70 = simulate(m15,fresh.signals.filter(s=>s.score>=70));
  const byAlignment = {};
  for (const key of ['aligned','countertrend','transition','mixed']) {
    byAlignment[key] = summarizeTrades(newRun._trades.filter(t=>t.alignment===key));
  }
  const byMaTrend = {};
  for (const key of ['bull','bear','neutral']) {
    byMaTrend[key] = summarizeTrades(newRun._trades.filter(t=>t.maTrend===key));
  }
  const split = m15.length - 60*96;
  const recentSignals = fresh.signals.filter(s=>s.index>=split);
  const priorSignals = fresh.signals.filter(s=>s.index<split);
  results.push({
    instrument:instId, bars:{m15:m15.length,h4:h4.length,d1:d1.length},
    oldHardGate:publicStats(oldRun),
    newAllCandidates:publicStats(newRun),
    newScore60:publicStats(new60),
    newScore70:publicStats(new70),
    newByAlignment:byAlignment,
    newByMaTrend:byMaTrend,
    newPrior120Days:publicStats(simulate(m15,priorSignals,split-1)),
    newRecent60Days:publicStats(simulate(m15,recentSignals)),
    rawSignals:{old:old.signals.length,oldPassed:old.signals.filter(s=>s.tradable).length,new:fresh.signals.length}
  });
}
const report={
  generatedAt:new Date().toISOString(),source:'OKX public history-candles',
  windowDays:DAYS,feePerSide:FEE_PER_SIDE,maxHoldBars:MAX_HOLD_BARS,
  execution:'next 15m candle open; stop takes priority if stop and target hit in same candle; timeout exits at close',
  caveats:['This is a first-pass signal replay, not a portfolio simulation.','Funding, market impact, spread variation and liquidation are not modeled.','Signals are evaluated on confirmed bars; entries occur on the next bar open.','The comparison uses the exact pre-change engine from commit 4fbcb85 and the current MA7/MA30 engine.'],
  results
};
writeFileSync('ma7-ma30-backtest.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
