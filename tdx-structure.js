(function(g){'use strict';
const D={penPeriod:7,halfPercent:50,timePeriod:1,atrPeriod:14,atrSwing:1.2,confirmBars:2,volumePeriod:20,stopAtr:0.35,targetR:2};
const finite=Number.isFinite,clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),nan=n=>Array(n).fill(NaN);
function ema(a,p){const out=nan(a.length),k=2/(p+1);let v=NaN;for(let i=0;i<a.length;i++){if(finite(a[i])){v=finite(v)?v+k*(a[i]-v):a[i];out[i]=v;}}return out;}
function compute(data,opts,tf){
 const p=Object.assign({},D,opts||{}),n=data.length,closed=data.map((x,i)=>({x,i})).filter(z=>z.x.confirmed===true||(!('confirmed'in z.x)&&z.i<n-1));
 const rows=closed.map(z=>z.x),idx=closed.map(z=>z.i),m=rows.length,H=rows.map(x=>+x.high),L=rows.map(x=>+x.low),C=rows.map(x=>+x.close),O=rows.map(x=>+x.open),V=rows.map(x=>+x.volume||0),tr=nan(m),atr=nan(m),dmP=nan(m),dmM=nan(m);
 for(let i=0;i<m;i++){const up=i?H[i]-H[i-1]:0,down=i?L[i-1]-L[i]:0;dmP[i]=up>down&&up>0?up:0;dmM[i]=down>up&&down>0?down:0;tr[i]=Math.max(H[i]-L[i],i?Math.abs(H[i]-C[i-1]):0,i?Math.abs(L[i]-C[i-1]):0);const s=Math.max(0,i-p.atrPeriod+1);atr[i]=tr.slice(s,i+1).reduce((a,b)=>a+b,0)/(i-s+1);}
 const smTR=ema(tr,p.atrPeriod),smDMp=ema(dmP,p.atrPeriod),smDMm=ema(dmM,p.atrPeriod),pDI=dmP.map((v,i)=>smTR[i]>0?100*smDMp[i]/smTR[i]:0),mDI=dmM.map((v,i)=>smTR[i]>0?100*smDMm[i]/smTR[i]:0),dx=pDI.map((v,i)=>v+mDI[i]>0?100*Math.abs(v-mDI[i])/(v+mDI[i]):0),adx=ema(dx,Math.max(3,p.atrPeriod));
 const macdFast=ema(C,12),macdSlow=ema(C,26),diff=macdFast.map((v,i)=>v-macdSlow[i]),macdSignal=ema(diff,9),hist=diff.map((v,i)=>v-macdSignal[i]);
 const pivots=[],labels=[],signals=[];
 const span=Math.max(4,Math.round(p.penPeriod*2)),confirm=Math.max(1,Math.floor(p.confirmBars)),divSeen={high:-1,low:-1};
 for(let i=confirm+1;i<m;i++){
  const j=i-confirm,a=Math.max(0,j-span+1);let hi=-Infinity,lo=Infinity,hiAt=-1,loAt=-1;
  for(let k=a;k<=j;k++){if(H[k]>hi){hi=H[k];hiAt=k;}if(L[k]<lo){lo=L[k];loAt=k;}}
  let candidates=[];if(hiAt===j)candidates.push('high');if(loAt===j)candidates.push('low');if(candidates.length===2)candidates=[C[j]>=O[j]?'low':'high'];
  for(const type of candidates){
   const price=type==='high'?H[j]:L[j],prev=pivots.at(-1),threshold=(atr[j]||tr[j])*p.atrSwing;
   if(prev&&prev.type===type){const moreExtreme=type==='high'?price>prev.price:price<prev.price;if(moreExtreme){labels.splice(0,labels.length,...labels.filter(x=>!(x.index===prev.index&&x.text===(type==='high'?'H':'L'))));prev.index=idx[j];prev.localIndex=j;prev.price=price;prev.confirmedAt=idx[i];prev.confirmLocal=i;labels.push({index:idx[j],price,text:type==='high'?'H':'L',color:type==='high'?'#df535b':'#22a45a'});}continue;}
   if(prev&&Math.abs(price-prev.price)<threshold)continue;
   const z={index:idx[j],localIndex:j,price,type,confirmedAt:idx[i],confirmLocal:i};pivots.push(z);labels.push({index:z.index,price,text:type==='high'?'H':'L',color:type==='high'?'#df535b':'#22a45a'});
  }
 }
 const highs=pivots.filter(z=>z.type==='high'),lows=pivots.filter(z=>z.type==='low'),lastH=highs.at(-1),prevH=highs.at(-2),lastL=lows.at(-1),prevL=lows.at(-2);
 const structureTrend=(h,ph,l,pl)=>h&&ph&&l&&pl?(h.price>ph.price&&l.price>pl.price?'bull':h.price<ph.price&&l.price<pl.price?'bear':'range'):'neutral';
 const trend=structureTrend(lastH,prevH,lastL,prevL),overlap=lastH&&lastL&&prevH&&prevL?Math.max(0,Math.min(lastH.price,prevH.price)-Math.max(lastL.price,prevL.price))/Math.max(1e-12,Math.min(lastH.price-lastL.price,prevH.price-prevL.price)):0;
 const lastAdx=adx.at(-1)||0,regime=trend==='range'?(lastAdx>=25?'structure-conflict':'range'):(overlap>.55&&lastAdx<22?'range':trend==='bull'?(lastAdx>=25?'strong-up':'weak-up'):trend==='bear'?(lastAdx>=25?'strong-down':'weak-down'):'unconfirmed');
 const levels={low1:lastL?.price,low2:prevL?.price,high1:lastH?.price,high2:prevH?.price,mid:lastH&&lastL?lastL.price+(lastH.price-lastL.price)*clamp(p.halfPercent,0,100)/100:NaN};
 const recentPivots=pivots.slice(-4),centerTop=recentPivots.length===4?Math.min(...[0,1,2].map(i=>Math.max(recentPivots[i].price,recentPivots[i+1].price))):NaN,centerBottom=recentPivots.length===4?Math.max(...[0,1,2].map(i=>Math.min(recentPivots[i].price,recentPivots[i+1].price))):NaN;levels.centerHigh=centerBottom<centerTop?centerTop:NaN;levels.centerLow=centerBottom<centerTop?centerBottom:NaN;levels.centerMid=centerBottom<centerTop?(centerTop+centerBottom)/2:NaN;
 const seen=[],trendSeries=[];
 for(let i=1;i<m;i++){
  const orig=idx[i];pivots.filter(z=>z.confirmedAt<=orig&&!seen.includes(z)).forEach(z=>seen.push(z));
  const hh=seen.filter(z=>z.type==='high'),ll=seen.filter(z=>z.type==='low'),h=hh.at(-1),l=ll.at(-1),ph=hh.at(-2),pl=ll.at(-2);
  const localTrend=structureTrend(h,ph,l,pl);trendSeries[orig]=localTrend;
  if(!h||!l||!ph||!pl||localTrend==='range'||(adx[i]||0)<12)continue;
  const prev=C[i-1],close=C[i],up=close>O[i],down=close<O[i],bodyRatio=Math.abs(close-O[i])/Math.max(H[i]-L[i],1e-12);
  const volN=Math.max(3,p.volumePeriod*p.timePeriod),vbase=V.slice(Math.max(0,i-volN),i),vavg=vbase.reduce((s,v)=>s+v,0)/Math.max(1,vbase.length),rvol=vavg?V[i]/vavg:1;
  const make=(name,dir,invalid)=>{const entry=close,buffer=(atr[i]||tr[i])*p.stopAtr,stop=dir==='long'?invalid-buffer:invalid+buffer,risk=Math.abs(entry-stop),structTarget=dir==='long'?(h.price>entry?h.price:NaN):(l.price<entry?l.price:NaN),target=finite(structTarget)&&Math.abs(structTarget-entry)>=risk?structTarget:entry+(dir==='long'?1:-1)*risk*p.targetR;const rr=risk>0?Math.abs(target-entry)/risk:0;const structureScore=(dir==='long'&&localTrend==='bull')||(dir==='short'&&localTrend==='bear')?30:15;const score=Math.round(clamp(structureScore+(rvol>=1.3?10:rvol>=1?6:0)+((adx[i]||0)>=25?15:(adx[i]||0)>=18?10:4)+(Math.min(1,Math.abs(close-h.price)/Math.max(atr[i]||1,1e-12))>=.5?10:5),0,100));signals.push({index:orig,price:entry,text:name,direction:dir,entry,stop,target,rr,rvol,atr:atr[i],score,confirmedAt:orig});};
  if(localTrend==='bull'&&up&&close>h.price&&prev<=h.price&&bodyRatio>=p.halfPercent/100)make('Breakout','long',l.price);
  if(localTrend==='bear'&&down&&close<l.price&&prev>=l.price&&bodyRatio>=p.halfPercent/100)make('Breakdown','short',h.price);
  const retest=(atr[i]||tr[i])*.45;
  if(localTrend==='bull'&&l.price>pl.price&&i>1&&prev>h.price&&L[i-1]>h.price+retest&&L[i]<=h.price+retest&&L[i]>=h.price-retest&&close>h.price&&up)make('3rd Buy','long',l.price);
  if(localTrend==='bear'&&h.price<ph.price&&i>1&&prev<l.price&&H[i-1]<l.price-retest&&H[i]>=l.price-retest&&H[i]<=l.price+retest&&close<l.price&&down)make('3rd Sell','short',h.price);
 }
 // Divergence is emitted once, at the confirmation bar of a new structural extreme.
 for(const z of pivots){const same=pivots.filter(x=>x.type===z.type&&x.confirmedAt<z.confirmedAt);if(!same.length)continue;const prev=same.at(-1),nowHist=hist[z.localIndex],oldHist=hist[prev.localIndex];if(z.type==='low'&&z.price<prev.price&&nowHist>oldHist&&divSeen.low!==z.confirmedAt){const entry=rows[z.confirmLocal].close,stop=z.price-(atr[z.localIndex]||tr[z.localIndex])*p.stopAtr,risk=entry-stop;signals.push({index:z.confirmedAt,price:entry,text:'Bull div',direction:'long',entry,stop,target:entry+risk*p.targetR,rr:p.targetR,confirmedAt:z.confirmedAt,score:55});divSeen.low=z.confirmedAt;}if(z.type==='high'&&z.price>prev.price&&nowHist<oldHist&&divSeen.high!==z.confirmedAt){const entry=rows[z.confirmLocal].close,stop=z.price+(atr[z.localIndex]||tr[z.localIndex])*p.stopAtr,risk=stop-entry;signals.push({index:z.confirmedAt,price:entry,text:'Bear div',direction:'short',entry,stop,target:entry-risk*p.targetR,rr:p.targetR,confirmedAt:z.confirmedAt,score:55});divSeen.high=z.confirmedAt;}}
 const stats=pivots.slice(-4).slice(1).map((z,i)=>{const a=pivots.slice(-4)[i];return {bars:z.index-a.index,change:(z.price-a.price)/a.price*100};});
 return {params:p,pivots,labels,signals:signals.sort((a,b)=>a.index-b.index),levels,trend,trendSeries,regime,adx:lastAdx,overlap,stats,barCount:m,confirmedOnly:true};
}
function mapClosedBias(lower,higher,higherResult,lowerDuration,higherDuration){
 const out=Array(lower.length).fill('neutral');
 if(!Array.isArray(higher)||!higher.length||!higherResult)return out;
 for(let i=0;i<lower.length;i++){
  const end=+lower[i].timestamp+lowerDuration;let picked=-1;
  for(let j=0;j<higher.length;j++){
   const x=higher[j],closed=x.confirmed===true||(!('confirmed'in x)&&j<higher.length-1);
   if(closed&&+x.timestamp+higherDuration<=end)picked=j;
  }
  if(picked>=0)out[i]=higherResult.trendSeries[picked]||'neutral';
 }
 return out;
}
function computeMultiTimeframe(data,htf,daily,opts,tf){
 const out=compute(data,opts,tf),is15=tf==='15m',is4h=tf==='4H';
 if(!is15&&!is4h){out.htf=null;out.daily=null;return out;}
 const localDur=is15?900000:14400000,dailyDur=86400000;
 const dailyResult=Array.isArray(daily)&&daily.length?compute(daily,opts,'1D'):null;
 const dailyBias=mapClosedBias(data,daily,dailyResult,localDur,dailyDur);
 let htfBias;
 if(is15){
  const htfResult=Array.isArray(htf)&&htf.length?compute(htf,opts,'4H'):null;
  htfBias=mapClosedBias(data,htf,htfResult,localDur,14400000);
 }else{
  htfBias=out.trendSeries.map(v=>v||'neutral');
 }
 out.daily={trend:dailyBias.at(-1)||'neutral',aligned:dailyBias,available:!!dailyResult};
 out.htf={trend:is4h?out.trend:(htfBias.at(-1)||'neutral'),aligned:htfBias,available:is4h||!!(htf&&htf.length)};
 out.signals=out.signals.map(s=>{
  const h=htfBias[s.index]||'neutral',d=dailyBias[s.index]||'neutral';
  const direction=s.direction==='long'?'bull':'bear';
  const hAligned=h===direction,dAligned=d===direction;
  const tradable=hAligned&&dAligned;
  const reasons=[];
  if(!dAligned)reasons.push(d==='neutral'?'1D unavailable/neutral':'1D '+d);
  if(!hAligned)reasons.push(h==='neutral'?'4H unavailable/neutral':'4H '+h);
  return Object.assign({},s,{htfTrend:h,dailyTrend:d,aligned:tradable,tradable,filterReason:reasons.join(' · '),score:clamp(s.score+(tradable?10:0),0,100)});
 });
 out.directionGate={required:['1D','4H'],passed:out.signals.filter(s=>s.tradable).length,blocked:out.signals.filter(s=>!s.tradable).length};
 return out;
}
function render(chart,data,r,lang){
 if(!chart||!data.length||!r)return;try{chart.removeOverlay({groupId:'tide-tdx-structure'});}catch(e){}const lib=g.klinecharts;if(!lib?.registerOverlay)return;
 if(!g.__tideTdxRegistered){lib.registerOverlay({name:'tideTdxLine',totalStep:3,lock:true,needDefaultPointFigure:false,createPointFigures:({coordinates,overlay})=>coordinates.length<2?[]:[{type:'line',attrs:{coordinates},styles:{color:overlay.extendData.color,size:1,style:'solid'}}]});lib.registerOverlay({name:'tideTdxText',totalStep:2,lock:true,needDefaultPointFigure:false,createPointFigures:({coordinates,overlay})=>!coordinates.length?[]:[{type:'text',attrs:{x:coordinates[0].x,y:coordinates[0].y,text:overlay.extendData.text,align:'center',baseline:'middle'},styles:{color:overlay.extendData.color,size:11,weight:'bold',backgroundColor:'rgba(10,20,30,.75)',paddingLeft:3,paddingRight:3}}]});g.__tideTdxRegistered=true;}
 const group='tide-tdx-structure',last=data.length-1,pt=(i,v)=>({timestamp:data[i].timestamp,value:v}),line=(a,b,c)=>{if(a&&b&&finite(a.value)&&finite(b.value))chart.createOverlay({name:'tideTdxLine',groupId:group,points:[a,b],lock:true,extendData:{color:c}});},txt=(i,v,t,c)=>{if(i>=0&&i<data.length&&finite(v))chart.createOverlay({name:'tideTdxText',groupId:group,points:[pt(i,v)],lock:true,extendData:{text:t,color:c}});};
 for(let i=1;i<r.pivots.length;i++){const a=r.pivots[i-1],b=r.pivots[i];line(pt(a.index,a.price),pt(b.index,b.price),'#d5a64a');}
 [['low1','#22a45a'],['high1','#df535b'],['mid','#e4a83d'],['centerHigh','#8c78d8'],['centerLow','#8c78d8'],['centerMid','#a995ed']].forEach(([k,c])=>{if(finite(r.levels[k])){line(pt(0,r.levels[k]),pt(last,r.levels[k]),c);if(k==='mid')txt(last,r.levels[k],'50% MID',c);if(k==='centerHigh')txt(last,r.levels[k],'CENTER',c);}});
 r.labels.slice(-35).forEach(x=>txt(x.index,x.price,x.text,x.color));
 r.signals.slice(-12).forEach(x=>txt(x.index,x.price,x.text+' '+x.score+(x.tradable===false?' · BLOCKED':''),x.tradable===false?'#9299a3':x.direction==='long'?'#22b88a':'#ed6676'));
 const trade=r.signals.at(-1);if(trade&&trade.index<=last&&trade.tradable!==false){[['entry','#4da3ff','ENTRY'],['stop','#e05b68','STOP'],['target','#22a45a','TARGET']].forEach(([k,color,label])=>{if(finite(trade[k])){line(pt(trade.index,trade[k]),pt(last,trade[k]),color);txt(last,trade[k],label+' '+trade[k].toPrecision(6),color);}});}
 txt(last,data[last].high*1.015,(lang==='en'?'Regime: ':'结构：')+r.regime+' · ADX '+r.adx.toFixed(0),r.trend==='bull'?'#22a45a':r.trend==='bear'?'#df535b':'#a0a8b2');
 if(r.daily)txt(last,data[last].high*1.035,(lang==='en'?'1D: ':'日线：')+r.daily.trend,r.daily.trend==='bull'?'#22a45a':r.daily.trend==='bear'?'#df535b':'#a0a8b2');if(r.htf)txt(last,data[last].high*1.055,(lang==='en'?'4H: ':'4H方向：')+r.htf.trend,r.htf.trend==='bull'?'#22a45a':r.htf.trend==='bear'?'#df535b':'#a0a8b2');
}
g.TideTdxStructure={defaults:D,compute,computeMultiTimeframe,render,timeframeMs:p=>({'15m':900000,'4H':14400000}[p]||900000)};
})(window);