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
  return { body, range: r.headers.get("content-range") };
}

const entityResponse = await req(
  "capital_entities?entity_key=eq.okx%3Aexchange&select=id&limit=2",
);
const entities = JSON.parse(entityResponse.body);
if (entities.length !== 1) throw new Error("Expected exactly one OKX entity");

const entityId = entities[0].id;
const filter = "entity_id=eq." + encodeURIComponent(entityId);

async function countRemaining() {
  const result = await req(
    "capital_entity_accounts?select=id&" + filter + "&limit=1",
    { headers: { Range: "0-0", Prefer: "count=exact" } },
  );
  const total = Number((result.range || "").split("/")[1]);
  if (!Number.isFinite(total)) {
    throw new Error("Could not read exact remaining count: " + result.range);
  }
  return total;
}

const initial = await countRemaining();
console.log("OKX target rows:", initial);

const batchSize = 1000;
let deleted = 0;

while (true) {
  const remainingBefore = await countRemaining();
  if (remainingBefore === 0) break;

  const offset = Math.min(batchSize - 1, remainingBefore - 1);
  const page = await req(
    "capital_entity_accounts?select=id&" +
      filter +
      "&order=id.asc&limit=1&offset=" +
      offset,
  );
  const rows = JSON.parse(page.body);
  if (rows.length !== 1) {
    throw new Error(
      "Could not determine safe deletion boundary; remaining=" + remainingBefore,
    );
  }

  const upperId = rows[0].id;
  await req(
    "capital_entity_accounts?id=lte." +
      encodeURIComponent(upperId) +
      "&" +
      filter,
    { method: "DELETE", headers: { Prefer: "return=minimal" } },
  );

  const remainingAfter = await countRemaining();
  const removed = remainingBefore - remainingAfter;
  if (removed <= 0) {
    throw new Error("Deletion made no progress; remaining=" + remainingAfter);
  }

  deleted += removed;
  console.log(
    "Removed " + deleted + " of " + initial + "; remaining=" + remainingAfter,
  );
}

const finalRemaining = await countRemaining();
if (finalRemaining !== 0) {
  throw new Error("Cleanup incomplete: " + finalRemaining);
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
