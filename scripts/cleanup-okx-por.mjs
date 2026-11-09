const baseRaw = process.env.SUPABASE_URL?.trim();
const base = baseRaw?.endsWith("/") ? baseRaw.slice(0, -1) : baseRaw;
const key = process.env.SUPABASE_SECRET_KEY;
if (!base || !key) throw new Error("Missing Supabase secrets");

const headers = {
  apikey: key,
  Authorization: "Bearer " + key,
  Accept: "application/json",
};

async function req(path, init = {}) {
  const r = await fetch(base + "/rest/v1/" + path, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const body = await r.text();
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + body.slice(0, 500));
  return body ? JSON.parse(body) : [];
}

const entities = await req(
  "capital_entities?entity_key=eq.okx%3Aexchange&select=id&limit=2",
);
if (entities.length !== 1) throw new Error("Expected exactly one OKX entity");

const entityId = entities[0].id;
const filter = "entity_id=eq." + encodeURIComponent(entityId);
const countRows = async () => {
  const result = await fetch(
    base + "/rest/v1/capital_entity_accounts?select=id&" + filter + "&limit=1",
    { headers: { ...headers, Prefer: "count=exact", Range: "0-0" } },
  );
  const body = await result.text();
  if (!result.ok) throw new Error("Count failed " + result.status + ": " + body);
  const total = Number((result.headers.get("content-range") || "").split("/")[1]);
  if (!Number.isFinite(total)) throw new Error("Could not read exact row count");
  return total;
};

const initial = await countRows();
console.log("OKX target rows:", initial);
const batchSize = 500;
let deleted = 0;

while (true) {
  const rows = await req(
    "capital_entity_accounts?select=id&" +
      filter +
      "&order=id.asc&limit=" +
      batchSize,
  );
  if (rows.length === 0) break;

  // The last selected UUID is the upper boundary of this ordered batch.
  // Keeping entity_id in the DELETE filter prevents touching other entities.
  const upperId = rows[rows.length - 1].id;
  const removed = await req(
    "capital_entity_accounts?id=lte." +
      encodeURIComponent(upperId) +
      "&" +
      filter +
      "&select=id",
    { method: "DELETE", headers: { Prefer: "return=representation" } },
  );

  if (!Array.isArray(removed) || removed.length === 0) {
    throw new Error("Deletion made no progress; stopping safely");
  }
  deleted += removed.length;
  console.log(
    "Removed " + deleted + " of " + initial + " (last batch " + removed.length + ")",
  );
}

const finalRemaining = await countRows();
if (finalRemaining !== 0) {
  throw new Error("Cleanup incomplete: " + finalRemaining + " rows remain");
}

console.log(
  JSON.stringify({
    ok: true,
    entity_key: "okx:exchange",
    initial_rows: initial,
    deleted_rows: deleted,
    remaining_rows: finalRemaining,
    scope: "Only capital_entity_accounts rows for the OKX exchange entity",
  }),
);
