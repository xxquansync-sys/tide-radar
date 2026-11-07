(function (global) {
  'use strict';
  const DEFAULTS = { penPeriod: 7, halfPercent: 50, limitPercent: 50, timePeriod: 1, confirmBars: 3 };
  const finite = Number.isFinite;
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const blank = (n,v=NaN) => Array.from({length:n},()=>v);
  const timeframeMs = p => ({'1m':60000,'5m':300000,'15m':900000,'1H':3600000,'4H':14400000,'1D':86400000}[p]||900000);
  const confirmedBars = data => data.map((x,i)=>({x,sourceIndex:i})).filter(({x,sourceIndex}) =>
    typeof x.confirmed === 'boolean' ? x.confirmed : sourceIndex < data.length-1
  );
  function ema(values, period) {
    const out=blank(values.length), k=2/(period+1); let prev=NaN;
    values.forEach((v,i)=>{ if(!finite(v))return; prev=finite(prev)?v*k+prev*(1-k):v; out[i]=prev; });
    return out;
  }
  function macdHist(values) {
    const a=ema(values,12),b=ema(values,26),d=a.map((v,i)=>v-b[i]),sig=ema(d,9);
    return d.map((v,i)=>(v-sig[i])*2);
  }
  function compute(data,input,period) {
    const p=Object.assign({},DEFAULTS,input||{}), rows=confirmedBars(data), n=data.length;
    const levels={low1:blank(n),high1:blank(n),low2:blank(n),high2:blank(n),low3:blank(n),high3:blank(n),high4:blank(n),mid:blank(n),abc:blank(n),one23:blank(n)};
    const pivots=[],labels=[],signals=[];
    const windowSize=Math.max(4,Math.floor(p.penPeriod*3+1));
    const confirmBars=Math.max(1,Math.floor(p.confirmBars));
    const H=rows.map(r=>+r.x.high),L=rows.map(r=>+r.x.low),C=rows.map(r=>+r.x.close),O=rows.map(r=>+r.x.open),hist=macdHist(C);
    let lastPivot=null;
    // A pivot is only published after confirmBars subsequent CLOSED candles.
    // The original rolling high/low window is evaluated at confirmation time;
    // no value is backfilled into the past and no open candle can trigger a signal.
    for(let i=0;i<rows.length;i++){
      const j=i-confirmBars;
      if(j<0)continue;
      const from=Math.max(0,i-windowSize+1);
      let hi=-Infinity,lo=Infinity,hiAt=-1,loAt=-1;
      for(let k=from;k<=i;k++){if(H[k]>hi){hi=H[k];hiAt=k;}if(L[k]<lo){lo=L[k];loAt=k;}}
      const isHigh=hiAt===j,isLow=loAt===j;
      if(!isHigh&&!isLow)continue;
      let type=isHigh?'high':'low';
      if(isHigh&&isLow) type=C[j]>=O[j]?'low':'high';
      if(lastPivot&&lastPivot.type===type) continue; // immutable confirmed pivots: never rewrite an earlier swing
      const pivot={index:rows[j].sourceIndex,price:type==='high'?H[j]:L[j],type,confirmedAt:rows[i].sourceIndex};
      pivots.push(pivot);lastPivot=pivot;
      labels.push({index:pivot.index,price:pivot.price,text:type==='high'?'高点':'低点',color:type==='high'?'#df535b':'#22a45a'});
    }
    const byType={high:[],low:[]};
    pivots.forEach(x=>byType[x.type].push(x));
    const fillLevel=(key,pivotList,rank)=>{
      const item=pivotList[pivotList.length-1-rank]; if(!item)return;
      for(let i=item.index;i<n;i++) levels[key][i]=item.price;
    };
    ['low1','low2','low3'].forEach((k,i)=>fillLevel(k,byType.low,i));
    ['high1','high2','high3','high4'].forEach((k,i)=>fillLevel(k,byType.high,i));
    const lastLow=byType.low.at(-1),lastHigh=byType.high.at(-1);
    for(let i=0;i<n;i++){
      if(finite(levels.low1[i])&&finite(levels.high1[i])){
        levels.mid[i]=levels.low1[i]+(levels.high1[i]-levels.low1[i])*(clamp(Number(p.halfPercent)||50,0,100)/100);
      }
    }
    // ABC/1-2-3 phase labels and dynamic elapsed-time / percentage statistics.
    const recent=pivots.slice(-4), rising=recent.length>=4&&recent[0].type==='low'&&recent[1].type==='high'&&recent[2].type==='low'&&recent[3].type==='high'&&recent[2].price>recent[0].price&&recent[3].price>recent[1].price;
    const falling=recent.length>=4&&recent[0].type==='high'&&recent[1].type==='low'&&recent[2].type==='high'&&recent[3].type==='low'&&recent[2].price<recent[0].price&&recent[3].price<recent[1].price;
    const cycle=(rising||falling)?'123':'ABC';
    recent.forEach((x,i)=>labels.push({index:x.index,price:x.price,text:cycle==='ABC'?['A','B','C','D'][i]:['1','2','3','4'][i],color:'#d34fd0'}));
    const stats=[];
    const phases=recent.slice(-4);
    for(let i=1;i<phases.length;i++){
      const a=phases[i-1],b=phases[i],base=a.price;
      stats.push({name:cycle==='ABC'?['OA','AB','BC'][i-1]:['01','12','23'][i-1],
        bars:Math.max(0,b.index-a.index),days:Math.max(0,(data[b.index].timestamp-data[a.index].timestamp)/86400000),
        change:base?((b.price-base)/base)*100:NaN});
    }
    // Signals are evaluated only on confirmed closes and use only pivots already confirmed at that bar.
    const pivotHistory=[];
    pivots.forEach(x=>pivotHistory.push(x));
    for(let r=0;r<rows.length;r++){
      const original=rows[r].sourceIndex, close=C[r], prev=r?C[r-1]:NaN, open=O[r];
      const seen=pivotHistory.filter(x=>x.confirmedAt<=original);
      const highs=seen.filter(x=>x.type==='high'),lows=seen.filter(x=>x.type==='low');
      const h1=highs.at(-1),h2=highs.at(-2),l1=lows.at(-1),l2=lows.at(-2);
      const crossed=(level)=>finite(level)&&finite(prev)&&prev<=level&&close>level;
      if(h1&&h2&&l1&&l2){
        if(crossed(h1.price)&&close>open)signals.push({index:original,price:+data[original].low,text:'一阳定势',color:'#ffb52e'});
        const higherLow=l1.price>l2.price, lowerHigh=h1.price<h2.price;
        if(higherLow&&lowerHigh&&close>open&&crossed(h1.price))signals.push({index:original,price:+data[original].low,text:'收敛',color:'#e6a23c'});
        if(higherLow&&h1.price>h2.price&&crossed(h2.price))signals.push({index:original,price:+data[original].low,text:'强势',color:'#ffb52e'});
        if(higherLow&&l1.price>h2.price&&close>open&&close>h2.price)signals.push({index:original,price:+data[original].low,text:'三买',color:'#ffb52e'});
        // MACD histogram divergence between the two most recent confirmed same-type fractals.
        const oldLow=lows.at(-2),newLow=lows.at(-1),oldHigh=highs.at(-2),newHigh=highs.at(-1);
        const histAt=(idx)=>{let k=rows.findIndex(z=>z.sourceIndex===idx);return k>=0?hist[k]:NaN;};
        if(oldLow&&newLow&&newLow.price<oldLow.price&&histAt(newLow.index)>histAt(oldLow.index))
          signals.push({index:original,price:+data[original].low,text:'底背驰',color:'#20b6a2'});
        if(oldHigh&&newHigh&&newHigh.price>oldHigh.price&&histAt(newHigh.index)<histAt(oldHigh.index))
          signals.push({index:original,price:+data[original].high,text:'顶背驰',color:'#ed6475'});
      }
    }
    const trend=(()=>{
      if(byType.high.length<2||byType.low.length<2)return 'neutral';
      const hh=byType.high.at(-1).price>byType.high.at(-2).price;
      const hl=byType.low.at(-1).price>byType.low.at(-2).price;
      const lh=byType.high.at(-1).price<byType.high.at(-2).price;
      const ll=byType.low.at(-1).price<byType.low.at(-2).price;
      return hh&&hl?'bull':lh&&ll?'bear':'neutral';
    })();
    return {params:p,pivots,labels,signals,levels,cycle,stats,trend,barCount:rows.length,confirmedOnly:true,period};
  }
  function computeMultiTimeframe(chartData,htfData,input,period) {
    const local=compute(chartData,input,period);
    if(period!=='15m'||!Array.isArray(htfData)||!htfData.length){local.htf=null;return local;}
    const htf=compute(htfData,input,'4H'), htfClosed=confirmedBars(htfData), htfDuration=timeframeMs('4H'), localDuration=timeframeMs('15m');
    const aligned=[];
    const htfPivots=htf.pivots;
    const trendAt=(barClose)=>{
      const usable=htfClosed.filter(({x})=>Number(x.timestamp)+htfDuration<=barClose);
      const allowed=usable.length?usable[usable.length-1].sourceIndex:-1;
      const seen=htfPivots.filter(p=>p.confirmedAt<=allowed);
      const highs=seen.filter(p=>p.type==='high'),lows=seen.filter(p=>p.type==='low');
      if(highs.length<2||lows.length<2)return 'neutral';
      const hh=highs.at(-1).price>highs.at(-2).price,hl=lows.at(-1).price>lows.at(-2).price;
      const lh=highs.at(-1).price<highs.at(-2).price,ll=lows.at(-1).price<lows.at(-2).price;
      return hh&&hl?'bull':lh&&ll?'bear':'neutral';
    };
    chartData.forEach((bar,i)=>{
      const closeTime=Number(bar.timestamp)+localDuration;
      aligned[i]=trendAt(closeTime);
    });
    local.htf={trend:htf.trend,analysis:htf,aligned};
    local.signals=local.signals.map(s=>{const t=aligned[s.index]||'neutral';return Object.assign({},s,{htfTrend:t,aligned:(s.text==='三买'||s.text==='一阳定势'||s.text==='强势')?t==='bull':(s.text==='顶背驰'?t==='bear':true)});});
    return local;
  }
  function render(chart,data,result,lang) {
    if(!chart||!data.length||!result)return;
    try{chart.removeOverlay({groupId:'tide-tdx-structure'});}catch(_){}
    const lib=global.klinecharts;if(!lib||!lib.registerOverlay)return;
    if(!global.__tideTdxOverlaysRegistered){
      lib.registerOverlay({name:'tideTdxLine',totalStep:3,lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,
        createPointFigures:({coordinates,overlay})=>coordinates.length<2?[]:[{type:'line',attrs:{coordinates},styles:{color:overlay.extendData.color||'#e0ad53',size:overlay.extendData.size||1,style:overlay.extendData.style||'solid',dashedValue:[3,3]}}]});
      lib.registerOverlay({name:'tideTdxText',totalStep:2,lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,
        createPointFigures:({coordinates,overlay})=>!coordinates.length?[]:[{type:'text',attrs:{x:coordinates[0].x,y:coordinates[0].y,text:overlay.extendData.text||'',align:'center',baseline:'middle'},styles:{color:overlay.extendData.color||'#d34fd0',size:overlay.extendData.size||11,weight:'bold',backgroundColor:'rgba(11,21,33,0.72)',paddingLeft:2,paddingRight:2,paddingTop:1,paddingBottom:1}}]});
      global.__tideTdxOverlaysRegistered=true;
    }
    const group='tide-tdx-structure',last=data.length-1,en=lang==='en';
    const point=(i,v)=>({timestamp:data[i].timestamp,value:v});
    const addLine=(a,b,color,style='solid',size=1)=>{if(a&&b&&finite(a.value)&&finite(b.value))chart.createOverlay({name:'tideTdxLine',groupId:group,points:[a,b],lock:true,extendData:{color,style,size}});};
    const addText=(i,v,t,c='#d34fd0',z=11)=>{if(i>=0&&i<data.length&&finite(v)&&t)chart.createOverlay({name:'tideTdxText',groupId:group,points:[point(i,v)],lock:true,extendData:{text:t,color:c,size:z}});};
    for(let i=1;i<result.pivots.length;i++){const a=result.pivots[i-1],b=result.pivots[i];addLine(point(a.index,a.price),point(b.index,b.price),'#e1ae54','solid',1.6);}
    result.pivots.slice(-40).forEach((p,i,arr)=>{const next=arr[i+1],end=next?next.index:last;if(end>p.index)addLine(point(p.index,p.price),point(end,p.price),p.type==='high'?'#df535b':'#22a45a','solid',1.5);});
    const specs=[['low1','#159b58'],['high1','#df535b'],['low2','#55b96b'],['high2','#e34d55'],['low3','#159b58'],['high3','#e34d55'],['high4','#e34d55'],['mid','#e6a23c']];
    specs.forEach(([key,color])=>{const v=result.levels[key][last];if(finite(v)){addLine(point(0,v),point(last,v),color,key==='mid'?'dashed':'solid',key==='mid'?2:1);if(key==='mid')addText(last,v,(en?'MID 50% ':'中位1 50% ')+v.toFixed(v<1?6:2),color,11);}});
    result.labels.slice(-36).forEach(x=>addText(x.index,x.price,en?({'高点':'High','低点':'Low','A':'A','B':'B','C':'C','D':'D'}[x.text]||x.text):x.text,x.color,11));
    result.signals.slice(-24).forEach(x=>{const text=en?({'一阳定势':'Bullish impulse','收敛':'Convergence','强势':'Strong','三买':'3rd Buy','底背驰':'Bullish divergence','顶背驰':'Bearish divergence'}[x.text]||x.text):x.text;addText(x.index,x.price,text,x.aligned===false?'#8a96a5':x.color,11);});
    if(result.htf&&result.htf.aligned.length){const t=result.htf.aligned[last]||'neutral';addText(last,data[last].high*1.015,(en?'4H Bias: ':'4H方向：')+(t==='bull'?(en?'Bullish':'偏多'):t==='bear'?(en?'Bearish':'偏空'):(en?'Neutral':'中性')),t==='bull'?'#22a45a':t==='bear'?'#df535b':'#9aa6b2',11);}
    const elapsed=(days)=>days<1?(days*24).toFixed(1)+'h':days.toFixed(1)+'d';
    result.stats.forEach((s,i)=>{const y=data[last].high*(1.025+i*.012);const txt=s.name+' '+elapsed(s.days)+' '+(finite(s.change)?(s.change>0?'+':'')+s.change.toFixed(2)+'%':'—');addText(Math.max(0,last-2),y,txt,['#289c57','#df5555','#278bd0'][i%3],10);});
  }
  global.TideTdxStructure={defaults:DEFAULTS,compute,computeMultiTimeframe,render,timeframeMs};
})(window);
