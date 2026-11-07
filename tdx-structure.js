(function (global) {
  'use strict';
  const DEFAULTS = { penPeriod: 7, halfPercent: 50, limitPercent: 50, timePeriod: 1 };
  const finite = Number.isFinite;
  function make(n, v) { return Array.from({ length: n }, () => v); }
  function backset(src, lengths) {
    const out = make(src.length, false);
    for (let i = 0; i < src.length; i++) if (src[i]) {
      const span = Math.max(1, Math.floor(lengths[i] || 1));
      for (let j = Math.max(0, i - span + 1); j <= i; j++) out[j] = true;
    }
    return out;
  }
  function filter(src, n) {
    const out = make(src.length, false); let next = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] && i >= next) { out[i] = true; next = i + Math.max(1, n) + 1; }
    }
    return out;
  }
  function barslast(src) {
    const out = make(src.length, 0); let last = -1;
    for (let i = 0; i < src.length; i++) { if (src[i]) last = i; out[i] = last < 0 ? i + 1 : i - last; }
    return out;
  }
  function count(src, i, n) {
    let c = 0; for (let j = Math.max(0, i - Math.max(1, n) + 1); j <= i; j++) if (src[j]) c++; return c;
  }
  function extremeBars(src, i, n, mode) {
    let best = mode === 'min' ? Infinity : -Infinity, at = i;
    for (let j = Math.max(0, i - Math.max(1, n) + 1); j <= i; j++) {
      const v = src[j];
      if (finite(v) && (mode === 'min' ? v < best : v > best)) { best = v; at = j; }
    }
    return i - at;
  }
  function rolling(src, i, n, mode) {
    let best = mode === 'min' ? Infinity : -Infinity;
    for (let j = Math.max(0, i - Math.max(1, n) + 1); j <= i; j++) {
      const v = src[j]; if (finite(v)) best = mode === 'min' ? Math.min(best, v) : Math.max(best, v);
    }
    return best;
  }
  function ref(src, i, n) { return i - n >= 0 ? src[i - n] : NaN; }
  function cross(a, b, i) { return i > 0 && finite(a[i]) && finite(b[i]) && finite(a[i - 1]) && finite(b[i - 1]) && a[i] > b[i] && a[i - 1] <= b[i - 1]; }
  function compute(data, input) {
    const p = Object.assign({}, DEFAULTS, input || {}), n = data.length;
    const H = data.map(x => +x.high), L = data.map(x => +x.low), C = data.map(x => +x.close), O = data.map(x => +x.open);
    const truth = () => make(n, false), nums = () => make(n, NaN);
    const A1=truth(),A2=truth();
    for(let i=0;i<n;i++){
      if(i>=3){A1[i]=ref(H,i,3)===rolling(H,i,p.penPeriod*3+1,'max');A2[i]=ref(L,i,3)===rolling(L,i,p.penPeriod*3+1,'min');}
    }
    const B1=filter(A1,3),B2=filter(A2,3);
    const C1=backset(B1,make(n,4)),C2=backset(B2,make(n,4));
    const D1=filter(C1,3),D2=filter(C2,3);
    const E1=nums(),E2=nums();
    for(let i=0;i<n;i++){E1[i]=(rolling(L,i-1,6,'min')+rolling(H,i-1,6,'max'))/2;E2[i]=(H[i]+L[i])/2;}
    const last=make(n,false),first=make(n,false);if(n){last[n-1]=true;first[0]=true;}
    const H1=truth(),H2=truth(),L1=truth();
    for(let i=0;i<n;i++){H2[i]=D1[i]&&!(D2[i]&&E1[i]>=E2[i]);L1[i]=D2[i]&&!(D1[i]&&E1[i]===E2[i]);H1[i]=H2[i]||last[i]||first[i];}
    const blH1=barslast(H1),blL1=barslast(L1),X1=make(n,1),X2=make(n,1);
    for(let i=0;i<n;i++){X1[i]=i>0?blH1[i-1]+1:1;}
    const f1src=L.map((v,i)=>L1[i]?v:100000),f1len=make(n,1),f1cond=truth();
    for(let i=0;i<n;i++){f1len[i]=extremeBars(f1src,i,X1[i],'min')+1;f1cond[i]=H1[i]&&count(L1,i,X1[i])>0;}
    const F1=backset(f1cond,f1len),G1=truth();for(let i=0;i<n;i++)G1[i]=F1[i]&&(i===0||!F1[i-1]);
    const I1=backset(G1,make(n,2)),LD=truth();for(let i=0;i<n;i++)LD[i]=I1[i]&&(i===0||!I1[i-1]);
    const L2=truth();for(let i=0;i<n;i++)L2[i]=LD[i]||last[i]||first[i];
    const blL2=barslast(L2);for(let i=0;i<n;i++)X2[i]=i>0?blL2[i-1]+1:1;
    const f2src=H.map((v,i)=>H2[i]?v:0),f2len=make(n,1),f2cond=truth();
    for(let i=0;i<n;i++){f2len[i]=extremeBars(f2src,i,X2[i],'max')+1;f2cond[i]=L2[i]&&count(H2,i,X2[i])>0;}
    const F2=backset(f2cond,f2len),G2=truth();for(let i=0;i<n;i++)G2[i]=F2[i]&&(i===0||!F2[i-1]);
    const I2=backset(G2,make(n,2)),HD=truth();for(let i=0;i<n;i++)HD[i]=I2[i]&&(i===0||!I2[i-1]);
    const blHD=barslast(HD),blLD=barslast(LD),J1len=make(n,1),J1cond=last.slice();
    for(let i=0;i<n;i++)J1len[i]=Math.min(blHD[i],blLD[i])+1;
    const J1=backset(J1cond,J1len),J2=truth();for(let i=0;i<n;i++)J2[i]=J1[i]&&(i===0||!J1[i-1]);

    const A3=H.slice(),B3=truth(),D3=truth(),E3len=make(n,1);
    for(let i=0;i<n;i++){
      const a=blHD[i], b=ref(blHD,i,a+1), c=ref(blHD,i,a+2+(finite(b)?(ref(blHD,i,a+2)||0):0));
      B3[i]=finite(b)&&finite(c)&&ref(H,i,a+1)>ref(H,i,a+2+(ref(blHD,i,a+2)||0));
      D3[i]=A3[i]&&B3[i]&&HD[i];E3len[i]=blHD[i]+2;
    }
    const E3=backset(D3,E3len),HH=truth();for(let i=0;i<n;i++)HH[i]=E3[i]&&(i===0||!E3[i-1]);
    const A4=truth(),B4=L.slice(),D4=truth(),E4len=make(n,1);
    for(let i=0;i<n;i++){A4[i]=L[i]>ref(L,i,blLD[i]+1);D4[i]=A4[i]&&finite(B4[i])&&LD[i];E4len[i]=blLD[i]+2;}
    const E4=backset(D4,E4len),LL=truth();for(let i=0;i<n;i++)LL[i]=E4[i]&&(i===0||!E4[i-1]);
    const H3=truth(),X3=make(n,1);for(let i=0;i<n;i++){H3[i]=HH[i]||last[i]||first[i];}
    const blH3=barslast(H3),blLL=barslast(LL);
    const f3src=L.map((v,i)=>LL[i]?v:Math.pow(10,20)),f3len=make(n,1),f3cond=truth();
    for(let i=0;i<n;i++){X3[i]=i>0?blH3[i-1]+1:1;f3len[i]=extremeBars(f3src,i,X3[i],'min')+1;f3cond[i]=H3[i]&&count(LL,i,X3[i])>0;}
    const F3=backset(f3cond,f3len),G3=truth();for(let i=0;i<n;i++)G3[i]=F3[i]&&(i===0||!F3[i-1]);
    const I3=backset(G3,make(n,2)),LZ=truth();for(let i=0;i<n;i++)LZ[i]=I3[i]&&(i===0||!I3[i-1]);
    const L4=truth(),X4=make(n,1);for(let i=0;i<n;i++)L4[i]=LZ[i]||last[i]||first[i];
    const blL4=barslast(L4),f4src=H.map((v,i)=>HH[i]?v:-Math.pow(10,20)),f4len=make(n,1),f4cond=truth();
    for(let i=0;i<n;i++){X4[i]=i>0?blL4[i-1]+1:1;f4len[i]=extremeBars(f4src,i,X4[i],'max')+1;f4cond[i]=L4[i]&&count(HH,i,X4[i])>0;}
    const F4=backset(f4cond,f4len),G4=truth();for(let i=0;i<n;i++)G4[i]=F4[i]&&(i===0||!F4[i-1]);
    const I4=backset(G4,make(n,2)),HZ=truth();for(let i=0;i<n;i++)HZ[i]=I4[i]&&(i===0||!I4[i-1]);
    const K1=backset(last,make(n,1).map((_,i)=>Math.min(blHD[i],barslast(LZ)[i])+1)),K2=truth();for(let i=0;i<n;i++)K2[i]=K1[i]&&(i===0||!K1[i-1]);

    const UU=backset(last,blLD.map(x=>x+1)),VV=truth();for(let i=0;i<n;i++)VV[i]=UU[i]&&(i===0||!UU[i-1]);
    const WW=backset(VV,blLD.map((_,i)=> (i>0?barslast(LD)[i-1]:0)+2)),XX=truth();for(let i=0;i<n;i++)XX[i]=WW[i]&&(i===0||!WW[i-1]);
    const WWQ=backset(XX,blLD.map((_,i)=>(i>0?barslast(LD)[i-1]:0)+2)),XXQ=truth();for(let i=0;i<n;i++)XXQ[i]=WWQ[i]&&(i===0||!WWQ[i-1]);
    const UU2=backset(last,blHD.map(x=>x+1)),VV2=truth();for(let i=0;i<n;i++)VV2[i]=UU2[i]&&(i===0||!UU2[i-1]);
    const WW2=backset(VV2,blHD.map((_,i)=>(i>0?barslast(HD)[i-1]:0)+2)),XX2=truth();for(let i=0;i<n;i++)XX2[i]=WW2[i]&&(i===0||!WW2[i-1]);
    const WW3Q=backset(XX2,blHD.map((_,i)=>(i>0?barslast(HD)[i-1]:0)+2)),XX3Q=truth();for(let i=0;i<n;i++)XX3Q[i]=WW3Q[i]&&(i===0||!WW3Q[i-1]);
    const WW4Q=backset(XX3Q,blHD.map((_,i)=>(i>0?barslast(HD)[i-1]:0)+2)),XX4Q=truth();for(let i=0;i<n;i++)XX4Q[i]=WW4Q[i]&&(i===0||!WW4Q[i-1]);
    const q=(a)=>barslast(a),Q0=q(XX2),Q1=q(XX),Q2=q(WW2),Q3=q(VV),Q4=q(XXQ),Q5=q(XX3Q),Q6=q(XX4Q);
    const levels={low1:nums(),high1:nums(),low2:nums(),high2:nums(),low3:nums(),high3:nums(),high4:nums(),mid:nums(),abc:nums(),one23:nums()};
    const pivots=[],labels=[],signals=[];
    function latestValue(src,values,i){const ago=src[i];return i-ago>=0?values[i-ago]:NaN;}
    for(let i=0;i<n;i++){
      levels.low1[i]=latestValue(VV,L,i);levels.high1[i]=latestValue(VV2,H,i);
      levels.low2[i]=latestValue(XX,L,i);levels.high2[i]=latestValue(XX2,H,i);
      levels.low3[i]=latestValue(XXQ,L,i);levels.high3[i]=latestValue(XX3Q,H,i);levels.high4[i]=latestValue(XX4Q,H,i);
      levels.mid[i]=levels.low1[i]-(levels.low1[i]-levels.high1[i])*(p.halfPercent/100);
      levels.abc[i]=Q5[i]>Q4[i]?latestValue(Q4,L,i):0;
      levels.one23[i]=Q5[i]<Q4[i]?latestValue(Q5,H,i):0;
      if(VV[i])labels.push({index:i,price:L[i],text:Q0[i]>Q1[i]?'C':Q0[i]<Q1[i]?'2':'',color:'#d34fd0'});
      if(VV2[i])labels.push({index:i,price:H[i],text:Q0[i]>Q1[i]?'B':Q0[i]<Q1[i]?'3':'',color:'#d34fd0'});
      if(XX[i])labels.push({index:i,price:L[i],text:Q0[i]>Q1[i]?'A':Q5[i]<Q4[i]?'◎':'',color:'#d34fd0'});
      if(XX2[i])labels.push({index:i,price:H[i],text:Q5[i]>Q4[i]?'◆':Q0[i]<Q1[i]?'1':'',color:'#d34fd0'});
      if(XXQ[i]&&Q5[i]>Q4[i])labels.push({index:i,price:L[i],text:'★',color:'#d34fd0'});
      if(XX3Q[i]&&Q5[i]<Q4[i])labels.push({index:i,price:H[i],text:'☆',color:'#d34fd0'});
    }
    let previous=-1;
    for(let i=0;i<n;i++){
      if(LD[i]||HD[i]){const type=LD[i]?'low':'high';pivots.push({index:i,price:type==='low'?L[i]:H[i],type});}
    }
    const pen=[];for(const point of pivots){if(point.index>previous){pen.push(point);previous=point.index;}}
    const V00=truth(),V01=truth(),V02=truth(),V03=truth(),V04=truth();
    for(let i=0;i<n;i++){
      V00[i]=H[i]<ref(H,i,1)&&L[i]<ref(L,i,1);
      V01[i]=H[i]<ref(H,i,1)&&L[i]>ref(L,i,1);
      V02[i]=H[i]>ref(H,i,1)&&L[i]<ref(L,i,1);
      V03[i]=H[i]>ref(H,i,1)&&L[i]>ref(L,i,1);
      V04[i]=i>=2&&ref(H,i,2)<H[i]&&ref(L,i,2)<L[i]&&ref(H,i,2)>ref(H,i,1)&&ref(L,i,2)<ref(L,i,1);
    }
    const XG1=truth(),XG2=truth(),XG=truth();
    for(let i=0;i<n;i++){
      const v1=count(V00,i,3)>=1&&extremeBars(L,i,3,'min')===1&&V03[i];
      const v2=count(V00,i,4)>=1&&extremeBars(L,i,4,'min')===2&&V04[i];
      const v3=count(V00,i,4)>=1&&count(V01.map((x,j)=>x||V02[j]),i,4)===1&&extremeBars(L,i,4,'min')===1&&V03[i];
      const v4=count(V00,i,5)>=1&&count(V01.map((x,j)=>x||V02[j]),i,5)===2&&extremeBars(L,i,5,'min')===2&&V04[i];
      XG1[i]=v1||v2||v3||v4;XG2[i]=C[i]>ref(H,i,1);XG[i]=XG1[i]&&XG2[i];
      const one=cross(C,levels.high1,i)&&cross(C,levels.high2,i)&&cross(C,levels.one23,i);
      const converging=levels.abc[i]>0&&levels.abc[i]<levels.low2[i]&&levels.low2[i]<levels.low1[i]&&levels.high2[i]>levels.high1[i]&&i>0&&C[i]>1&&C[i-1]<=1;
      const strong=levels.abc[i]>0&&levels.abc[i]<levels.low2[i]&&levels.low2[i]<levels.low1[i]&&levels.high2[i]<levels.high1[i]&&cross(C,levels.high1,i);
      const third=levels.low1[i]>levels.high2[i]&&levels.mid[i]>levels.low1[i]&&XG[i]&&C[i]>O[i];
      if(one)signals.push({index:i,price:L[i],text:'一阳定势',color:'#ffb52e'});
      if(converging)signals.push({index:i,price:L[i],text:'收敛',color:'#ffb52e'});
      if(strong)signals.push({index:i,price:L[i],text:'强势',color:'#ffb52e'});
      if(third)signals.push({index:i,price:L[i],text:'三买',color:'#ffb52e'});
    }
    const lastI=n-1, cycle=lastI>=0?(Q5[lastI]>Q4[lastI]?'ABC':'123'):'ABC';
    const stats=cycle==='ABC'?[
      {name:'◆—A',bars:Q0[lastI]-Q1[lastI]+1,change:NaN},{name:'A—B',bars:Q1[lastI]-Q2[lastI]+1,change:NaN},
      {name:'B—C',bars:Q2[lastI]-Q3[lastI]+1,change:NaN},{name:'C—',bars:Q3[lastI]+1,change:NaN}
    ]:[
      {name:'◎—1',bars:Q1[lastI]-Q0[lastI]+1,change:NaN},{name:'1—2',bars:Q0[lastI]-Q3[lastI]+1,change:NaN},
      {name:'2—3',bars:Q3[lastI]-Q2[lastI]+1,change:NaN},{name:'3—',bars:Q2[lastI]+1,change:NaN}
    ];
    if(lastI>=0){
      if(cycle==='ABC'){
        const vals=[(latestValue(XX2,C,lastI)-latestValue(XX,C,lastI))/latestValue(XX,C,lastI)*100,
          (latestValue(VV2,C,lastI)-latestValue(XX,C,lastI))/latestValue(XX,C,lastI)*100,
          (latestValue(VV,C,lastI)-latestValue(VV2,C,lastI))/latestValue(VV2,C,lastI)*100,
          (C[lastI]-latestValue(VV,C,lastI))/latestValue(VV,C,lastI)*100];
        stats.forEach((s,i)=>s.change=vals[i]);
      }else{
        const vals=[(latestValue(XX2,C,lastI)-latestValue(XX,C,lastI))/latestValue(XX,C,lastI)*100,
          (latestValue(VV,C,lastI)-latestValue(XX2,C,lastI))/latestValue(XX2,C,lastI)*100,
          (latestValue(VV2,C,lastI)-latestValue(VV,C,lastI))/latestValue(VV,C,lastI)*100,
          (C[lastI]-latestValue(VV2,C,lastI))/latestValue(VV2,C,lastI)*100];
        stats.forEach((s,i)=>s.change=vals[i]);
      }
    }
    // Crypto adaptation: there is no exchange-wide daily price ceiling/floor.
    // Replace A-share limit-up/down tags with volatility/volume outlier tags.
    const extremes=[];
    const tr=make(n,0),atr=make(n,NaN),volAvg=make(n,NaN);
    for(let i=0;i<n;i++){
      const prev=i>0?C[i-1]:C[i];
      tr[i]=Math.max(H[i]-L[i],Math.abs(H[i]-prev),Math.abs(L[i]-prev));
      const atrWindow=Math.max(2,14*(Number(p.timePeriod)||1));
      const from=Math.max(0,i-atrWindow+1);let sum=0,cnt=0;
      for(let j=from;j<=i;j++){sum+=tr[j];cnt++;}
      atr[i]=cnt?sum/cnt:NaN;
      const volWindow=Math.max(2,20*(Number(p.timePeriod)||1));
      const vf=Math.max(0,i-volWindow+1);let vs=0,vc=0;
      for(let j=vf;j<=i;j++){const v=Number(data[j].volume);if(finite(v)){vs+=v;vc++;}}
      volAvg[i]=vc?vs/vc:NaN;
      const range=H[i]-L[i],body=Math.abs(C[i]-O[i]),vol=Number(data[i].volume);
      const bodyRatio=range>0?body/range:0;
      const volatilityOutlier=finite(atr[i])&&atr[i]>0&&range>=2.2*atr[i]&&bodyRatio>=Math.max(0,Math.min(100,Number(p.limitPercent)||50))/100;
      const volumeConfirm=!finite(volAvg[i])||volAvg[i]<=0||!finite(vol)||vol>=1.35*volAvg[i];
      if(i>=14&&volatilityOutlier&&volumeConfirm){
        extremes.push({index:i,price:C[i],text:C[i]>=O[i]?'急涨':'急跌',type:C[i]>=O[i]?'up':'down',color:C[i]>=O[i]?'#f0b52d':'#27b9c8'});
      }
    }
    // Keep the source's ABC/123 phase logic; show candle counts rather than assuming each bar is a day.
    stats.forEach(s=>{s.bars=Math.max(0,Math.round(Number(s.bars)||0));});
    return {params:p,pivots:pen,labels,signals,extremes,levels,cycle,stats,barCount:n};
  }

  function render(chart, data, result, lang) {
    if (!chart || !data.length || !result) return;
    try { chart.removeOverlay({ groupId: 'tide-tdx-structure' }); } catch (_) {}
    const lib=global.klinecharts;
    if (!lib || !lib.registerOverlay) return;
    if (!global.__tideTdxOverlaysRegistered) {
      lib.registerOverlay({name:'tideTdxLine',totalStep:3,lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,
        createPointFigures:({coordinates,overlay})=>coordinates.length<2?[]:[{type:'line',attrs:{coordinates},styles:{color:overlay.extendData.color||'#e0ad53',size:overlay.extendData.size||1,style:overlay.extendData.style||'solid',dashedValue:[3,3]}}]});
      lib.registerOverlay({name:'tideTdxText',totalStep:2,lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,
        createPointFigures:({coordinates,overlay})=>!coordinates.length?[]:[{type:'text',attrs:{x:coordinates[0].x,y:coordinates[0].y,text:overlay.extendData.text||'',align:'center',baseline:'middle'},styles:{color:overlay.extendData.color||'#d34fd0',size:overlay.extendData.size||11,weight:'bold',backgroundColor:overlay.extendData.bg||'rgba(255,255,255,0.75)',paddingLeft:2,paddingRight:2,paddingTop:1,paddingBottom:1}}]});
      lib.registerOverlay({name:'tideTdxZone',totalStep:3,lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,
        createPointFigures:({coordinates,overlay})=>coordinates.length<2?[]:[{type:'rect',attrs:{x:Math.min(coordinates[0].x,coordinates[1].x),y:Math.min(coordinates[0].y,coordinates[1].y),width:Math.abs(coordinates[1].x-coordinates[0].x),height:Math.abs(coordinates[1].y-coordinates[0].y)},styles:{style:'fill',color:overlay.extendData.color||'rgba(100,100,100,0.25)',borderColor:'rgba(100,100,100,0.35)',borderSize:1}}]});
      global.__tideTdxOverlaysRegistered=true;
    }
    const group='tide-tdx-structure', last=data.length-1, lastTs=data[last].timestamp;
    const point=(i,v)=>({timestamp:data[i].timestamp,value:v});
    const addLine=(a,b,color,style,size)=>{if(a&&b&&finite(a.value)&&finite(b.value))chart.createOverlay({name:'tideTdxLine',groupId:group,points:[a,b],lock:true,extendData:{color,style,size}});};
    const addText=(i,v,text,color,size)=>{if(i>=0&&i<data.length&&finite(v)&&text)chart.createOverlay({name:'tideTdxText',groupId:group,points:[point(i,v)],lock:true,extendData:{text,color,size}});};
    // Orange swing-pen polyline between confirmed structural highs/lows.
    for(let i=1;i<result.pivots.length;i++){
      const a=result.pivots[i-1],b=result.pivots[i];
      addLine(point(a.index,a.price),point(b.index,b.price),'#e1ae54','solid',1.6);
    }
    // Explicit horizontal high/low pivot levels, each held until the next confirmed pivot.
    result.pivots.slice(-40).forEach((p,i,arr)=>{
      const next=arr[i+1],end=next?next.index:last;
      if(end>p.index)addLine(point(p.index,p.price),point(end,p.price),p.type==='high'?'#df535b':'#22a45a','solid',1.5);
      const tag=en? (p.type==='high'?'HIGH':'LOW') : (p.type==='high'?'高点':'低点');
      addText(p.index,p.price,tag,p.type==='high'?'#df535b':'#22a45a',10);
    });
    // Current structural levels and the 50% midpoint, extended to the latest candle.
    const specs=[['low1','#159b58','solid',2],['high1','#df535b','solid',2],['low2','#55b96b','dashed',1],['high2','#e34d55','dashed',1],['low3','#159b58','dashed',1],['high3','#e34d55','dashed',1],['high4','#e34d55','dashed',1],['mid','#e6a23c','dashed',2]];
    specs.forEach(([key,color,style,size])=>{
      const arr=result.levels[key],v=arr[last];if(!finite(v))return;
      let start=last;
      while(start>0&&finite(arr[start-1])&&Math.abs(arr[start-1]-v)<1e-8)start--;
      addLine(point(start,v),point(last,v),color,style,size);
      if(key==='mid')addText(last,v,(en?'50% MID':'半分位 50%')+' · '+v.toFixed(v<1?6:2),'#e6a23c',11);
    });
    result.labels.slice(-36).forEach(x=>addText(x.index,x.price,x.text,x.color,12));
    const en=lang==='en';
    const signalText={ '一阳定势':'Bullish impulse', '收敛':'Convergence', '强势':'Strong', '三买':'3rd Buy', '急涨':'Surge', '急跌':'Drop' };
    result.signals.slice(-24).forEach(x=>addText(x.index,x.price,en?(signalText[x.text]||x.text):x.text,x.color,11));
    (result.extremes||[]).slice(-30).forEach(x=>addText(x.index,x.price,en?(signalText[x.text]||x.text):x.text,x.color,11));
    // Cycle statistics use bar counts plus actual elapsed time for the active timeframe.
    const elapsed=(bars)=>{
      if(!bars||last<1)return '—';
      const first=Math.max(0,last-bars+1),ms=Math.max(0,data[last].timestamp-data[first].timestamp);
      const mins=Math.round(ms/60000);
      if(mins<60)return mins+'m';
      if(mins<1440)return (mins/60).toFixed(1)+'h';
      return (mins/1440).toFixed(1)+'d';
    };
    result.stats.forEach((s,i)=>{
      const text=s.name+'  '+s.bars+(en?' bars':'根K')+' / '+elapsed(s.bars)+'  '+(finite(s.change)?(s.change>0?'+':'')+s.change.toFixed(2)+'%':'—');
      addText(Math.max(0,last-Math.min(8,data.length-1)),data[last].high*(1.008+i*0.006),text,i===0?'#289c57':i===1?'#df5555':i===2?'#289c57':'#278bd0',10);
    });
  }
  global.TideTdxStructure={defaults:DEFAULTS,compute,render};
})(window);
