(function(g){'use strict';
const D={penPeriod:7,halfPercent:50,timePeriod:1,atrPeriod:14,atrSwing:1.2,confirmBars:2,volumePeriod:20};
const ok=Number.isFinite,clamp=(x,a,b)=>Math.max(a,Math.min(b,x)),arr=n=>Array(n).fill(NaN);
function ema(a,p){let o=arr(a.length),k=2/(p+1),v=NaN;a.forEach((x,i)=>{if(ok(x)){v=ok(v)?v+k*(x-v):x;o[i]=v;}});return o;}
function compute(data,opts,tf){
 const p=Object.assign({},D,opts||{}),n=data.length,closed=data.map((x,i)=>({x,i})).filter(z=>z.x.confirmed===true||(!('confirmed'in z.x)&&z.i<n-1));
 const rows=closed.map(z=>z.x),idx=closed.map(z=>z.i),m=rows.length,H=rows.map(x=>+x.high),L=rows.map(x=>+x.low),C=rows.map(x=>+x.close),V=rows.map(x=>+x.volume||0),tr=arr(m),atr=arr(m);
 for(let i=0;i<m;i++){tr[i]=Math.max(H[i]-L[i],i?Math.abs(H[i]-C[i-1]):0,i?Math.abs(L[i]-C[i-1]):0);let s=0,c=0;for(let j=Math.max(0,i-p.atrPeriod+1);j<=i;j++){s+=tr[j];c++;}atr[i]=s/c;}
 const mh=ema(C,12),ml=ema(C,26),diff=mh.map((x,i)=>x-ml[i]),sig=ema(diff,9);hist=diff.map((x,i)=>2*(x-sig[i]));
 const pivots=[],labels=[],signals=[],lastByType={high:null,low:null};let last=null;
 const span=Math.max(4,Math.round(p.penPeriod*2)),confirm=Math.max(1,Math.floor(p.confirmBars));
 for(let i=0;i<m;i++){let j=i-confirm;if(j<1)continue;let a=Math.max(0,j-span+1),hi=-Infinity,lo=Infinity,hiAt=-1,loAt=-1;
 for(let k=a;k<=j;k++){if(H[k]>hi){hi=H[k];hiAt=k;}if(L[k]<lo){lo=L[k];loAt=k;}}
 let candidates=[];if(hiAt===j)candidates.push('high');if(loAt===j)candidates.push('low');if(candidates.length===2)candidates=[C[j]>=rows[j].open?'low':'high'];
 for(const type of candidates){let price=type==='high'?H[j]:L[j],old=lastByType[type],minMove=(ok(atr[j])?atr[j]:tr[j])*p.atrSwing;
 if(old&&Math.abs(price-old.price)<minMove)continue;
 if(last&&last.type===type){if((type==='high'&&price<=last.price)||(type==='low'&&price>=last.price))continue;}
 const z={index:idx[j],localIndex:j,price,type,confirmedAt:idx[i],confirmLocal:i};pivots.push(z);lastByType[type]=z;last=z;labels.push({index:z.index,price,text:type==='high'?'H':'L',color:type==='high'?'#df535b':'#22a45a'});
 }}
 const highs=pivots.filter(x=>x.type==='high'),lows=pivots.filter(x=>x.type==='low'),lastH=highs.at(-1),prevH=highs.at(-2),lastL=lows.at(-1),prevL=lows.at(-2);
 const trend=lastH&&prevH&&lastL&&prevL?(lastH.price>prevH.price&&lastL.price>prevL.price?'bull':lastH.price<prevH.price&&lastL.price<prevL.price?'bear':'range'):'neutral';
 const regime=trend==='range'?'range':trend==='bull'?'strong-up':trend==='bear'?'strong-down':'unconfirmed';
 const levels={low1:lastL?.price,low2:prevL?.price,high1:lastH?.price,high2:prevH?.price,mid:lastH&&lastL?lastL.price+(lastH.price-lastL.price)*clamp(p.halfPercent,0,100)/100:NaN};
 const seen=[];for(let i=0;i<m;i++){let original=idx[i];pivots.filter(z=>z.confirmedAt<=original&&!seen.includes(z)).forEach(z=>seen.push(z));
 const hh=seen.filter(z=>z.type==='high'),ll=seen.filter(z=>z.type==='low'),h=hh.at(-1),l=ll.at(-1),ph=hh.at(-2),pl=ll.at(-2);
 if(!h||!l||!ph||!pl)continue;
 const localTrend=h.price>ph.price&&l.price>pl.price?'bull':h.price<ph.price&&l.price<pl.price?'bear':'range';
 if(localTrend==='range')continue;
 const prev=C[i-1],close=C[i],open=rows[i].open,body=Math.abs(close-open),bodyRatio=body/Math.max(H[i]-L[i],1e-12);
 const volumeBase=V.slice(Math.max(0,i-p.volumePeriod*p.timePeriod),i).reduce((s,x)=>s+x,0)/Math.max(1,Math.min(i,p.volumePeriod*p.timePeriod));
 const rvol=volumeBase>0?V[i]/volumeBase:1,up=close>open,down=close<open;
 const push=(text,price,dir)=>signals.push({index:original,price,text,direction:dir,rvol,atr:atr[i],confirmedAt:original});
 if(localTrend==='bull'&&up&&close>h.price&&prev<=h.price&&bodyRatio>=p.halfPercent/100)push('Breakout',L[i],'long');
 if(localTrend==='bear'&&down&&close<l.price&&prev>=l.price&&bodyRatio>=p.halfPercent/100)push('Breakdown',H[i],'short');
 if(localTrend==='bull'&&l.price>pl.price&&close>h.price&&prev<=h.price&&up)push('3rd Buy',L[i],'long');
 if(localTrend==='bear'&&h.price<ph.price&&close<l.price&&prev>=l.price&&down)push('3rd Sell',H[i],'short');
 if(l.price<pl.price&&hist[i]>hist[Math.max(0,l.localIndex-1)])push('Bull div',L[i],'long');
 if(h.price>ph.price&&hist[i]<hist[Math.max(0,h.localIndex-1)])push('Bear div',H[i],'short');
 }
 const stats=pivots.slice(-4).slice(1).map((z,i)=>{const a=pivots.slice(-4)[i];return {bars:z.index-a.index,change:(z.price-a.price)/a.price*100};});
 return {params:p,pivots,labels,signals,levels,trend,regime,stats,barCount:m,confirmedOnly:true};
}
function computeMultiTimeframe(data,htf,opts,tf){const out=compute(data,opts,tf);if(tf!=='15m'||!htf?.length){out.htf=null;return out;}
 const higher=compute(htf,opts,'4H'),dur=14400000,localDur=900000;
 const bias=data.map(b=>{let end=+b.timestamp+localDur;let allowed=htf.filter((x,i)=>{const closed=x.confirmed===true||(!('confirmed'in x)&&i<htf.length-1);return closed&&+x.timestamp+dur<=end;});if(!allowed.length)return 'neutral';const last=allowed.at(-1),cut=+last.timestamp+dur;const subset=htf.filter((x,i)=>+x.timestamp+dur<=cut&&(x.confirmed===true||(!('confirmed'in x)&&i<htf.length-1)));return compute(subset,opts,'4H').trend;});
 out.htf={trend:higher.trend,aligned:bias};out.signals=out.signals.map(s=>Object.assign({},s,{htfTrend:bias[s.index]||'neutral',aligned:s.direction==='long'?bias[s.index]==='bull':bias[s.index]==='bear'}));return out;}
function render(chart,data,r,lang){if(!chart||!data.length||!r)return;try{chart.removeOverlay({groupId:'tide-tdx-structure'});}catch(e){}const lib=g.klinecharts;if(!lib?.registerOverlay)return;
 if(!g.__tideTdxRegistered){lib.registerOverlay({name:'tideTdxLine',totalStep:3,lock:true,needDefaultPointFigure:false,createPointFigures:({coordinates,overlay})=>coordinates.length<2?[]:[{type:'line',attrs:{coordinates},styles:{color:overlay.extendData.color,size:1,style:'solid'}}]});lib.registerOverlay({name:'tideTdxText',totalStep:2,lock:true,needDefaultPointFigure:false,createPointFigures:({coordinates,overlay})=>!coordinates.length?[]:[{type:'text',attrs:{x:coordinates[0].x,y:coordinates[0].y,text:overlay.extendData.text,align:'center',baseline:'middle'},styles:{color:overlay.extendData.color,size:11,weight:'bold',backgroundColor:'rgba(10,20,30,.75)',paddingLeft:3,paddingRight:3}}]});g.__tideTdxRegistered=true;}
 const group='tide-tdx-structure',last=data.length-1,pt=(i,v)=>({timestamp:data[i].timestamp,value:v}),line=(a,b,c)=>{if(a&&b&&ok(a.value)&&ok(b.value))chart.createOverlay({name:'tideTdxLine',groupId:group,points:[a,b],lock:true,extendData:{color:c}});},txt=(i,v,t,c)=>{if(i>=0&&i<data.length&&ok(v))chart.createOverlay({name:'tideTdxText',groupId:group,points:[pt(i,v)],lock:true,extendData:{text:t,color:c}});};
 for(let i=1;i<r.pivots.length;i++){const a=r.pivots[i-1],b=r.pivots[i];line(pt(a.index,a.price),pt(b.index,b.price),'#d5a64a');}
 [['low1','#22a45a'],['high1','#df535b'],['mid','#e4a83d']].forEach(([k,c])=>{if(ok(r.levels[k])){line(pt(0,r.levels[k]),pt(last,r.levels[k]),c);if(k==='mid')txt(last,r.levels[k],'50% MID',c);}});
 r.labels.slice(-35).forEach(x=>txt(x.index,x.price,x.text,x.color));
 r.signals.slice(-20).forEach(x=>txt(x.index,x.price,(lang==='en'?x.text:x.text)+(x.aligned===false?' · 4H mismatch':''),x.aligned===false?'#9299a3':x.direction==='long'?'#22b88a':'#ed6676'));
 txt(last,data[last].high*1.015,(lang==='en'?'Regime: ':'结构：')+r.regime,r.trend==='bull'?'#22a45a':r.trend==='bear'?'#df535b':'#a0a8b2');
 if(r.htf)txt(last,data[last].high*1.035,(lang==='en'?'4H: ':'4H方向：')+r.htf.trend,r.htf.trend==='bull'?'#22a45a':r.htf.trend==='bear'?'#df535b':'#a0a8b2');
}
g.TideTdxStructure={defaults:D,compute,computeMultiTimeframe,render,timeframeMs:p=>({'15m':900000,'4H':14400000}[p]||900000)};
})(window);