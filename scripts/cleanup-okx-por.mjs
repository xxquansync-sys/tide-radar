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
const batchSize = 500;
let deleted = 0;

const hasRemainingRows = async () => {
  const rows = await req(
    "capital_entity_accounts?select=id&" + filter + "&limit=1",
  );
  return rows.length > 0;
};

while (true) {
  const rows = await req(
    "capital_entity_accounts?select=id&" +
      filter +
      "&order=id.asc&limit=" +
      batchSize,
  );
  if (rows.length === 0) break;

  // Delete exactly the IDs selected for this batch. Keep the entity filter
  // as a second guard so no account belonging to another entity can be touched.
  const idList = rows.map((row) => row.id).join(",");
  const removed = await req(
    "capital_entity_accounts?id=in.(" +
      idList +
      ")&" +
      filter +
      "&select=id",
    { method: "DELETE", headers: { Prefer: "return=representation" } },
  );

  if (!Array.isArray(removed) || removed.length !== rows.length) {
    throw new Error(
      "Unexpected batch delete count: selected " +
        rows.length +
        ", deleted " +
        (Array.isArray(removed) ? removed.length : "invalid response"),
    );
  }
  deleted += removed.length;
  console.log("Removed " + deleted + " OKX account rows (batch " + removed.length + ")");
}

if (await hasRemainingRows()) {
  throw new Error("Cleanup incomplete: OKX account rows remain");
}

console.log(
  JSON.stringify({
    ok: true,
    entity_key: "okx:exchange",
    deleted_rows: deleted,
    remaining_rows: 0,
    batch_size: batchSize,
    scope: "Only capital_entity_accounts rows for the OKX exchange entity",
  }),
);
