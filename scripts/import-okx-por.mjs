import { inflateRawSync, deflateRawSync } from 'node:zlib';
const PAGE='https://www.okx.com/en-us/proof-of-reserves/download';
const SUPABASE=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const KEY=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENTITY_KEY='okx:exchange',SOURCE='OKX official Proof of Reserves wallet file';

async function latestReport(){
  if(process.env.OKX_POR_ZIP_URL){const m=process.env.OKX_POR_ZIP_URL.match(/por_csv_(\d{10})_V1\.zip/i);if(!m)throw Error('Invalid OKX_POR_ZIP_URL');return{url:process.env.OKX_POR_ZIP_URL,stamp:m[1]};}
  const r=await fetch(PAGE,{headers:{Accept:'text/html','User-Agent':'TideRadar-Capital-Intelligence/1.0'}});if(!r.ok)throw Error('OKX PoR page HTTP '+r.status);
  const html=(await r.text()).replace(/\\\//g,'/');
  const ms=[...html.matchAll(/(?:https?:)?\/\/static\.okx\.com\/cdn\/okx\/por\/chain\/por_csv_(\d{10})_V1\.zip/gi)];
  if(!ms.length)throw Error('No official OKX PoR wallet ZIP link found');
  ms.sort((a,b)=>b[1].localeCompare(a[1]));return{url:'https:'+ms[0][0].replace(/^https?:/i,''),stamp:ms[0][1]};
}
function unzipCsv(zip){
  const sig=Buffer.from([0x50,0x4b,0x05,0x06]);let end=-1;
  for(let i=zip.length-22;i>=Math.max(0,zip.length-65557);i--)if(zip.subarray(i,i+4).equals(sig)){end=i;break;}
  if(end<0)throw Error('Invalid ZIP: EOCD missing');
  const count=zip.readUInt16LE(end+10);let off=zip.readUInt32LE(end+16);
  for(let i=0;i<count;i++){
    if(zip.readUInt32LE(off)!==0x02014b50)throw Error('Invalid ZIP central directory');
    const flags=zip.readUInt16LE(off+8),method=zip.readUInt16LE(off+10),size=zip.readUInt32LE(off+20);
    const nl=zip.readUInt16LE(off+28),el=zip.readUInt16LE(off+30),cl=zip.readUInt16LE(off+32),local=zip.readUInt32LE(off+42);
    const name=zip.subarray(off+46,off+46+nl).toString('utf8');
    if(name.toLowerCase().endsWith('.csv')){
      if(flags&1)throw Error('Encrypted ZIP unsupported');
      if(zip.readUInt32LE(local)!==0x04034b50)throw Error('Invalid ZIP local header');
      const start=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28),data=zip.subarray(start,start+size);
      if(method===0)return data.toString('utf8');if(method===8)return inflateRawSync(data).toString('utf8');
      throw Error('Unsupported ZIP method '+method);
    }
    off+=46+nl+el+cl;
  }
  throw Error('No CSV found in ZIP');
}
function csvLine(line){const out=[];let v='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){v+='"';i++;}else q=!q;}else if(c===','&&!q){out.push(v);v='';}else v+=c;}out.push(v);return out;}
function parseSnapshot(csv,stamp){
  const lines=csv.replace(/^\uFEFF/,'').split(/\r?\n/),hi=lines.findIndex(x=>x.trim().toLowerCase().startsWith('coin,type,network,snapshot height,address,amount,'));
  if(hi<0)throw Error('PoR wallet-address CSV header missing');
  const headers=csvLine(lines[hi]).map(x=>x.trim().toLowerCase()),idx=Object.fromEntries(headers.map((x,i)=>[x,i]));
  for(const k of ['coin','type','network','snapshot height','address','amount','message','signature1'])if(idx[k]===undefined)throw Error('Missing CSV column '+k);
  const at=new Date(stamp.slice(0,4)+'-'+stamp.slice(4,6)+'-'+stamp.slice(6,8)+'T'+stamp.slice(8,10)+':00:00+08:00').toISOString(),rows=[];
  for(const line of lines.slice(hi+1)){if(!line.trim())continue;const c=csvLine(line),get=k=>(c[idx[k]]||'').trim(),coin=get('coin'),network=get('network'),address=get('address'),amount=get('amount');if(!coin||!network||!address||!amount||!/^\d+(?:\.\d+)?$/.test(amount))continue;
    rows.push({coin,network,address,amount,type:get('type'),snapshot_height:get('snapshot height'),message:get('message'),signature1:get('signature1'),signature2:get('signature2'),redeem_script_or_public_key:get('redeem script/ public key'),eoa1:get('eoa1'),eoa2:get('eoa2'),snapshot_at:at});
  }
  if(!rows.length)throw Error('No valid PoR wallet rows');return rows;
}
async function db(table,q='',o={}){const r=await fetch(SUPABASE+'/rest/v1/'+table+(q?'?'+q:''),{method:o.method||'GET',headers:{apikey:KEY,Authorization:'Bearer '+KEY,Accept:'application/json',...(o.body?{'Content-Type':'application/json'}:{}),...(o.prefer?{Prefer:o.prefer}:{})},...(o.body?{body:JSON.stringify(o.body)}:{})});const t=await r.text();if(!r.ok)throw Error(table+' HTTP '+r.status+': '+t.slice(0,600));return t?JSON.parse(t):[];}
async function upsert(table,rows,conflict,select){const out=[];for(let i=0;i<rows.length;i+=250){const q='on_conflict='+encodeURIComponent(conflict)+(select?'&select='+encodeURIComponent(select):'');const r=await db(table,q,{method:'POST',body:rows.slice(i,i+250),prefer:'resolution=merge-duplicates,return='+(select?'representation':'minimal')});if(select)out.push(...r);}return out;}
async function importReport(report,csv){
  const wallets=parseSnapshot(csv,report.stamp),at=wallets[0].snapshot_at;
  const entities=await db('capital_entities','on_conflict=entity_key&select=id,entity_key',{method:'POST',body:[{entity_key:ENTITY_KEY,display_name:'OKX Exchange',entity_type:'exchange',identity_status:'known',confidence:1,description:'Exchange-level reserve wallet pool sourced from OKX signed Proof of Reserves wallet files.',tags:['exchange','proof-of-reserves','custody-pool'],source_refs:[{title:SOURCE,url:report.url}],last_seen_at:at,metadata:{source_scope:'published_proof_of_reserves_wallets',report_stamp:report.stamp}}],prefer:'resolution=merge-duplicates,return=representation'});
  if(!entities.length)throw Error('Could not resolve OKX entity');const entityId=entities[0].id;
  const dedup=new Map();
  for(const x of wallets){const k=x.network+'|'+x.address;const old=dedup.get(k);if(old){if(!old.asset_scope.includes(x.coin))old.asset_scope.push(x.coin);old.metadata.por_records.push({coin:x.coin,type:x.type,snapshot_height:x.snapshot_height,signature1:x.signature1,signature2:x.signature2});}else dedup.set(k,{entity_id:entityId,network:x.network,account_ref:x.address,account_kind:'exchange_wallet',account_role:'unknown',asset_scope:[x.coin],attribution_basis:'OKX official PoR wallet file; signed address ownership claim retained, not cryptographically verified by this importer.',confidence:0.95,source_url:report.url,source_refs:[{title:SOURCE,url:report.url,report_stamp:report.stamp}],metadata:{por_records:[{coin:x.coin,type:x.type,snapshot_height:x.snapshot_height,signature1:x.signature1,signature2:x.signature2,message:x.message,redeem_script_or_public_key:x.redeem_script_or_public_key,eoa1:x.eoa1,eoa2:x.eoa2}]}});
  }
  await upsert('capital_entity_accounts',[...dedup.values()],'network,account_ref,account_kind');
  const refs=await db('capital_entity_accounts','select=id,network,account_ref&entity_id=eq.'+encodeURIComponent(entityId)+'&account_kind=eq.exchange_wallet&limit=10000');
  const ids=new Map(refs.map(x=>[x.network+'|'+x.account_ref,x.id]));
  const balances=wallets.map(x=>{const id=ids.get(x.network+'|'+x.address);if(!id)throw Error('Account mapping missing '+x.network+':'+x.address);return{balance_key:'okx-por:'+report.stamp+':'+x.network+':'+x.address+':'+x.coin,entity_account_id:id,asset:x.coin,amount:x.amount,snapshot_at:x.snapshot_at,snapshot_height:x.snapshot_height,source:SOURCE,source_url:report.url,data_quality:'observed',metadata:{report_stamp:report.stamp,por_type:x.type,signature_present:Boolean(x.signature1),ownership_signature_verified:false}};});
  await upsert('capital_entity_account_balances',balances,'balance_key');
  return{report_stamp:report.stamp,snapshot_at:at,wallet_rows:wallets.length,unique_addresses:dedup.size,balance_rows:balances.length,assets:[...new Set(wallets.map(x=>x.coin))].sort()};
}
function crc32(buf){let c=0xffffffff;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function zipFixture(name,content){const n=Buffer.from(name),raw=Buffer.from(content),packed=deflateRawSync(raw),crc=crc32(raw),local=Buffer.alloc(30+n.length),central=Buffer.alloc(46+n.length),end=Buffer.alloc(22);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(n.length,26);n.copy(local,30);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(0,42);n.copy(central,46);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(local.length+packed.length,16);return Buffer.concat([local,packed,central,end]);}
function test(){const csv=['coin,amount','BTC,123','','coin,Type,Network,Snapshot Height,address,amount,message,signature1,signature2,redeem script/ public key,EOA1,EOA2','BTC,Non Staking,BTC,900,bc1qtest,1.25000000,I am an OKX address,signature,,,,','ETH,Native ETH Staking,ETH,1900,0xabc,2.5,I am an OKX address,signature,second,,0xdef,'].join(String.fromCharCode(10));const r=parseSnapshot(csv,'2026110100');if(r.length!==2||r[1].type!=='Native ETH Staking'||r[1].eoa1!=='0xdef'||r[0].snapshot_at!=='2026-10-31T16:00:00.000Z')throw Error('PoR CSV parser test failed');if(csvLine('"asset, wrapped",Type')[0]!=='asset, wrapped')throw Error('Quoted CSV parser test failed');if(unzipCsv(zipFixture('report.csv',csv))!==csv)throw Error('ZIP extraction test failed');console.log('OKX PoR importer tests passed: CSV sections, wallet fields, signatures, UTC+8 timestamp, ZIP extraction.');}
async function main(){if(!SUPABASE||!KEY)throw Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');const report=await latestReport(),r=await fetch(report.url,{headers:{Accept:'application/zip,application/octet-stream,*/*','User-Agent':'TideRadar-Capital-Intelligence/1.0'}});if(!r.ok)throw Error('PoR ZIP HTTP '+r.status);const csv=unzipCsv(Buffer.from(await r.arrayBuffer()));const result=await importReport(report,csv);console.log(JSON.stringify({...result,source:SOURCE,signature_verification:'not_performed; signed fields retained for future verification'}));}
if(process.env.TIDE_POR_IMPORT_TEST==='1')test();else main().catch(e=>{console.error(e);process.exitCode=1;});
