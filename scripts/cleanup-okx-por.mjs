const baseRaw = process.env.SUPABASE_URL?.trim();
const base = baseRaw?.endsWith("/") ? baseRaw.slice(0, -1) : baseRaw;
const key = process.env.SUPABASE_SECRET_KEY;
if (!base || !key) throw new Error("Missing Supabase secrets");
const headers = { apikey:key, Authorization:"Bearer "+key, Accept:"application/json" };
async function req(path, init={}) {
  const r = await fetch(base+"/rest/v1/"+path,{...init,headers:{...headers,...(init.headers||{})}});
  const body=await r.text();
  if(!r.ok) throw new Error("Supabase "+r.status+": "+body.slice(0,500));
  return {body,range:r.headers.get("content-range")};
}
const e=await req("capital_entities?entity_key=eq.okx%3Aexchange&select=id&limit=2");
const entities=JSON.parse(e.body);
if(entities.length!==1) throw new Error("Expected one OKX entity");
const id=entities[0].id, filter="entity_id=eq."+encodeURIComponent(id);
const count=async()=>{const r=await req("capital_entity_accounts?select=id&"+filter+"&limit=1",{headers:{Range:"0-0",Prefer:"count=exact"}});const n=Number((r.range||"").split("/")[1]);if(!Number.isFinite(n))throw new Error("Count unavailable: "+r.range);return n;};
const initial=await count();
console.log("OKX target rows:",initial);
let deleted=0;
while(true){
  const b=await req("capital_entity_accounts?select=id&"+filter+"&order=id.asc&limit=1&offset=4999");
  const rows=JSON.parse(b.body);
  if(!rows.length)break;
  const upper=rows[0].id;
  await req("capital_entity_accounts?id=lte."+encodeURIComponent(upper)+"&"+filter,{method:"DELETE",headers:{Prefer:"return=minimal"}});
  const left=await count();
  const batch=initial-deleted-left;
  if(batch<=0)throw new Error("No deletion progress; stopped");
  deleted+=batch;
  console.log("Removed",deleted,"of",initial);
  if(left===0)break;
}
const remaining=await count();
if(remaining!==0)throw new Error("Cleanup incomplete: "+remaining);
console.log(JSON.stringify({ok:true,initial_rows:initial,deleted_rows:deleted,remaining_rows:remaining}));
