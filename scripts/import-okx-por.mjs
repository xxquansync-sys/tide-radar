import { inflateRawSync, deflateRawSync } from 'node:zlib';

const PAGE = 'https://www.okx.com/en-us/proof-of-reserves/download';
const SUPABASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENTITY_KEY = 'okx:exchange';
const SOURCE = 'OKX official Proof of Reserves wallet file';
const TOP_WALLETS_PER_ASSET = 500;

async function latestReport() {
  if (process.env.OKX_POR_ZIP_URL) {
    const m = process.env.OKX_POR_ZIP_URL.match(/por_csv_(\d{10})_V1\.zip/i);
    if (!m) throw Error('Invalid OKX_POR_ZIP_URL');
    return { url: process.env.OKX_POR_ZIP_URL, stamp: m[1] };
  }
  const r = await fetch(PAGE, {
    headers: { Accept: 'text/html', 'User-Agent': 'TideRadar-Capital-Intelligence/1.0' },
  });
  if (!r.ok) throw Error('OKX PoR page HTTP ' + r.status);
  const html = (await r.text()).replace(/\\\//g, '/');
  const matches = [...html.matchAll(/(?:https?:)?\/\/static\.okx\.com\/cdn\/okx\/por\/chain\/por_csv_(\d{10})_V1\.zip/gi)];
  if (!matches.length) throw Error('No official OKX PoR wallet ZIP link found');
  matches.sort((a, b) => b[1].localeCompare(a[1]));
  return { url: 'https:' + matches[0][0].replace(/^https?:/i, ''), stamp: matches[0][1] };
}

function unzipCsv(zip) {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.subarray(i, i + 4).equals(sig)) { end = i; break; }
  }
  if (end < 0) throw Error('Invalid ZIP: EOCD missing');
  const count = zip.readUInt16LE(end + 10);
  let off = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(off) !== 0x02014b50) throw Error('Invalid ZIP central directory');
    const flags = zip.readUInt16LE(off + 8);
    const method = zip.readUInt16LE(off + 10);
    const size = zip.readUInt32LE(off + 20);
    const nl = zip.readUInt16LE(off + 28);
    const el = zip.readUInt16LE(off + 30);
    const cl = zip.readUInt16LE(off + 32);
    const local = zip.readUInt32LE(off + 42);
    const name = zip.subarray(off + 46, off + 46 + nl).toString('utf8');
    if (name.toLowerCase().endsWith('.csv')) {
      if (flags & 1) throw Error('Encrypted ZIP unsupported');
      if (zip.readUInt32LE(local) !== 0x04034b50) throw Error('Invalid ZIP local header');
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return inflateRawSync(data).toString('utf8');
      throw Error('Unsupported ZIP method ' + method);
    }
    off += 46 + nl + el + cl;
  }
  throw Error('No CSV found in ZIP');
}

function csvLine(line) {
  const out = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { out.push(value); value = ''; }
    else value += c;
  }
  out.push(value);
  return out;
}

function validAmount(value) {
  return /^\d+(?:\.\d+)?$/.test(String(value || '').trim());
}

function compareAmount(a, b) {
  const [ai, af = ''] = String(a).split('.');
  const [bi, bf = ''] = String(b).split('.');
  const x = ai.replace(/^0+/, '') || '0';
  const y = bi.replace(/^0+/, '') || '0';
  if (x.length !== y.length) return x.length > y.length ? -1 : 1;
  if (x !== y) return x > y ? -1 : 1;
  const scale = Math.max(af.length, bf.length);
  const ax = af.padEnd(scale, '0');
  const bx = bf.padEnd(scale, '0');
  return ax === bx ? 0 : ax > bx ? -1 : 1;
}

function addAmounts(values) {
  const scale = Math.max(0, ...values.map(v => (String(v).split('.')[1] || '').length));
  const factor = 10n ** BigInt(scale);
  let total = 0n;
  for (const value of values) {
    const [whole, fraction = ''] = String(value).split('.');
    total += BigInt(whole) * factor + BigInt(fraction.padEnd(scale, '0') || '0');
  }
  if (!scale) return total.toString();
  const digits = total.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : whole;
}

function parseSnapshot(csv, stamp) {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  const walletHeaderIndex = lines.findIndex(line =>
    line.trim().toLowerCase().startsWith('coin,type,network,snapshot height,address,amount,'),
  );
  if (walletHeaderIndex < 0) throw Error('PoR wallet-address CSV header missing');

  const walletHeaders = csvLine(lines[walletHeaderIndex]).map(x => x.trim().toLowerCase());
  const idx = Object.fromEntries(walletHeaders.map((x, i) => [x, i]));
  for (const key of ['coin', 'type', 'network', 'snapshot height', 'address', 'amount', 'message', 'signature1']) {
    if (idx[key] === undefined) throw Error('Missing CSV column ' + key);
  }

  const snapshotAt = new Date(
    stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8) +
    'T' + stamp.slice(8, 10) + ':00:00+08:00',
  ).toISOString();

  const summaryHeaderIndex = lines.findIndex((line, i) =>
    i < walletHeaderIndex && line.trim().toLowerCase() === 'coin,amount',
  );
  const summaryMap = new Map();
  if (summaryHeaderIndex >= 0) {
    for (const line of lines.slice(summaryHeaderIndex + 1, walletHeaderIndex)) {
      if (!line.trim()) continue;
      const cells = csvLine(line);
      const coin = (cells[0] || '').trim();
      const amount = (cells[1] || '').trim();
      if (coin && validAmount(amount)) summaryMap.set(coin, amount);
    }
  }

  const wallets = [];
  for (const line of lines.slice(walletHeaderIndex + 1)) {
    if (!line.trim()) continue;
    const cells = csvLine(line);
    const get = key => (cells[idx[key]] || '').trim();
    const coin = get('coin');
    const network = get('network');
    const address = get('address');
    const amount = get('amount');
    if (!coin || !network || !address || !validAmount(amount)) continue;
    wallets.push({
      coin, network, address, amount, type: get('type'),
      snapshot_height: get('snapshot height'), message: get('message'),
      signature1: get('signature1'), signature2: get('signature2'),
      redeem_script_or_public_key: get('redeem script/ public key'),
      eoa1: get('eoa1'), eoa2: get('eoa2'), snapshot_at: snapshotAt,
    });
  }
  if (!wallets.length) throw Error('No valid PoR wallet rows');

  const fallbackTotals = new Map();
  for (const wallet of wallets) {
    if (!fallbackTotals.has(wallet.coin)) fallbackTotals.set(wallet.coin, []);
    fallbackTotals.get(wallet.coin).push(wallet.amount);
  }
  const summaries = summaryMap.size
    ? [...summaryMap].map(([asset, amount]) => ({ asset, amount, source: 'official_csv_summary' }))
    : [...fallbackTotals].map(([asset, values]) => ({
        asset, amount: addAmounts(values), source: 'sum_of_published_wallet_rows',
      }));

  return { wallets, summaries, snapshot_at: snapshotAt };
}

function selectTopWallets(wallets, limit = TOP_WALLETS_PER_ASSET) {
  const byAsset = new Map();
  for (const wallet of wallets) {
    const key = wallet.coin + '|' + wallet.network + '|' + wallet.address;
    if (!byAsset.has(wallet.coin)) byAsset.set(wallet.coin, new Map());
    const current = byAsset.get(wallet.coin).get(key);
    if (!current || compareAmount(wallet.amount, current.amount) > 0) {
      byAsset.get(wallet.coin).set(key, wallet);
    }
  }
  const selected = [];
  for (const [asset, unique] of byAsset) {
    const ranked = [...unique.values()].sort((a, b) => compareAmount(a.amount, b.amount));
    selected.push(...ranked.slice(0, limit));
  }
  return selected;
}

async function db(table, query = '', options = {}) {
  const response = await fetch(SUPABASE + '/rest/v1/' + table + (query ? '?' + query : ''), {
    method: options.method || 'GET',
    headers: {
      apikey: KEY, Authorization: 'Bearer ' + KEY, Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw Error(table + ' HTTP ' + response.status + ': ' + text.slice(0, 600));
  return text ? JSON.parse(text) : [];
}

async function upsert(table, rows, conflict, select) {
  const output = [];
  for (let i = 0; i < rows.length; i += 250) {
    const query = 'on_conflict=' + encodeURIComponent(conflict) +
      (select ? '&select=' + encodeURIComponent(select) : '');
    const result = await db(table, query, {
      method: 'POST', body: rows.slice(i, i + 250),
      prefer: 'resolution=merge-duplicates,return=' + (select ? 'representation' : 'minimal'),
    });
    if (select) output.push(...result);
  }
  return output;
}

async function importReport(report, csv) {
  const parsed = parseSnapshot(csv, report.stamp);
  const selectedWallets = selectTopWallets(parsed.wallets);
  const at = parsed.snapshot_at;

  const entities = await db(
    'capital_entities', 'on_conflict=entity_key&select=id,entity_key',
    {
      method: 'POST',
      body: [{
        entity_key: ENTITY_KEY, display_name: 'OKX Exchange', entity_type: 'exchange',
        identity_status: 'known', confidence: 1,
        description: 'Exchange-level reserve wallet pool sourced from OKX official Proof of Reserves.',
        tags: ['exchange', 'proof-of-reserves', 'custody-pool'],
        source_refs: [{ title: SOURCE, url: report.url }],
        last_seen_at: at,
        metadata: { source_scope: 'published_proof_of_reserves_wallets', report_stamp: report.stamp },
      }],
      prefer: 'resolution=merge-duplicates,return=representation',
    },
  );
  if (!entities.length) throw Error('Could not resolve OKX entity');
  const entityId = entities[0].id;

  const snapshots = parsed.summaries.map(item => ({
    snapshot_key: 'okx-por:' + report.stamp + ':' + item.asset,
    entity_id: entityId, asset: item.asset, reserve_amount: item.amount,
    snapshot_at: at, source: SOURCE, source_url: report.url,
    data_quality: item.source === 'official_csv_summary' ? 'observed' : 'partial',
    metadata: {
      report_stamp: report.stamp, summary_basis: item.source,
      published_wallet_rows: parsed.wallets.filter(x => x.coin === item.asset).length,
      tracked_wallet_limit_per_asset: TOP_WALLETS_PER_ASSET,
    },
  }));
  await upsert('capital_entity_asset_snapshots', snapshots, 'snapshot_key');

  const accountMap = new Map();
  for (const wallet of selectedWallets) {
    const key = wallet.network + '|' + wallet.address;
    const record = accountMap.get(key);
    const porRecord = {
      coin: wallet.coin, type: wallet.type, snapshot_height: wallet.snapshot_height,
      signature1: wallet.signature1, signature2: wallet.signature2,
      message: wallet.message,
      redeem_script_or_public_key: wallet.redeem_script_or_public_key,
      eoa1: wallet.eoa1, eoa2: wallet.eoa2,
    };
    if (record) {
      if (!record.asset_scope.includes(wallet.coin)) record.asset_scope.push(wallet.coin);
      record.metadata.por_records.push(porRecord);
    } else {
      accountMap.set(key, {
        entity_id: entityId, network: wallet.network, account_ref: wallet.address,
        account_kind: 'exchange_wallet', account_role: 'unknown',
        asset_scope: [wallet.coin],
        attribution_basis: 'OKX official PoR wallet file; signed ownership claim retained but not cryptographically verified by this importer.',
        confidence: 0.95, source_url: report.url,
        source_refs: [{ title: SOURCE, url: report.url, report_stamp: report.stamp }],
        metadata: { por_records: [porRecord] },
      });
    }
  }

  const savedAccounts = await upsert(
    'capital_entity_accounts', [...accountMap.values()],
    'network,account_ref,account_kind', 'id,network,account_ref',
  );
  const ids = new Map(savedAccounts.map(row => [row.network + '|' + row.account_ref, row.id]));
  if (ids.size !== accountMap.size) {
    throw Error('Saved account mapping incomplete: expected ' + accountMap.size + ', got ' + ids.size);
  }

  const balances = selectedWallets.map(wallet => {
    const accountId = ids.get(wallet.network + '|' + wallet.address);
    if (!accountId) throw Error('Account mapping missing ' + wallet.network + ':' + wallet.address);
    return {
      balance_key: 'okx-por:' + report.stamp + ':' + wallet.network + ':' + wallet.address + ':' + wallet.coin,
      entity_account_id: accountId, asset: wallet.coin, amount: wallet.amount,
      snapshot_at: at, snapshot_height: wallet.snapshot_height, source: SOURCE,
      source_url: report.url, data_quality: 'observed',
      metadata: {
        report_stamp: report.stamp, por_type: wallet.type,
        signature_present: Boolean(wallet.signature1), ownership_signature_verified: false,
        wallet_rank_scope: 'top_' + TOP_WALLETS_PER_ASSET + '_per_asset',
      },
    };
  });
  await upsert('capital_entity_account_balances', balances, 'balance_key');

  return {
    report_stamp: report.stamp, snapshot_at: at,
    published_wallet_rows: parsed.wallets.length,
    tracked_wallet_rows: selectedWallets.length,
    unique_tracked_addresses: accountMap.size,
    balance_rows: balances.length,
    asset_snapshots: snapshots.length,
    assets: snapshots.map(x => x.asset).sort(),
    top_wallet_limit_per_asset: TOP_WALLETS_PER_ASSET,
  };
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function zipFixture(name, content) {
  const n = Buffer.from(name), raw = Buffer.from(content), packed = deflateRawSync(raw);
  const crc = crc32(raw), local = Buffer.alloc(30 + n.length);
  const central = Buffer.alloc(46 + n.length), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26); n.copy(local, 30);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42); n.copy(central, 46);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + packed.length, 16);
  return Buffer.concat([local, packed, central, end]);
}

function test() {
  const csv = [
    'coin,amount', 'BTC,124.75', 'ETH,987.125', '',
    'coin,Type,Network,Snapshot Height,address,amount,message,signature1,signature2,redeem script/ public key,EOA1,EOA2',
    'BTC,Non Staking,BTC,900,bc1qtest,1.25000000,I am an OKX address,signature,,,,',
    'ETH,Native ETH Staking,ETH,1900,0xabc,2.5,I am an OKX address,signature,second,,0xdef,',
    'BTC,Non Staking,BTC,901,bc1qtest2,3.5,I am an OKX address,signature,,,,',
  ].join(String.fromCharCode(10));

  const parsed = parseSnapshot(csv, '2026110100');
  if (parsed.wallets.length !== 3 || parsed.summaries.length !== 2) throw Error('CSV sections test failed');
  if (parsed.wallets[1].type !== 'Native ETH Staking' || parsed.wallets[1].eoa1 !== '0xdef') throw Error('Wallet fields test failed');
  if (parsed.snapshot_at !== '2026-10-31T16:00:00.000Z') throw Error('UTC+8 timestamp test failed');
  if (csvLine('"asset, wrapped",Type')[0] !== 'asset, wrapped') throw Error('Quoted CSV parser test failed');
  if (unzipCsv(zipFixture('report.csv', csv)) !== csv) throw Error('ZIP extraction test failed');
  if (compareAmount('100.0001', '99.9999') >= 0) throw Error('Exact decimal ranking test failed');
  if (addAmounts(['1.25', '2.5', '0.005']) !== '3.755') throw Error('Exact decimal summary test failed');
  const ranked = selectTopWallets(parsed.wallets, 1);
  if (ranked.length !== 2 || !ranked.some(x => x.address === 'bc1qtest2')) throw Error('Top wallet selection test failed');
  console.log('OKX compact PoR tests passed: summary parsing, wallet parsing, exact decimal ranking/sum, top-N filtering, ZIP extraction.');
}

async function main() {
  if (!SUPABASE || !KEY) throw Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  const report = await latestReport();
  const response = await fetch(report.url, {
    headers: { Accept: 'application/zip,application/octet-stream,*/*', 'User-Agent': 'TideRadar-Capital-Intelligence/1.0' },
  });
  if (!response.ok) throw Error('PoR ZIP HTTP ' + response.status);
  const csv = unzipCsv(Buffer.from(await response.arrayBuffer()));
  const result = await importReport(report, csv);
  console.log(JSON.stringify({
    ...result, source: SOURCE,
    signature_verification: 'not_performed; signed fields retained for future verification',
    reserve_totals_basis: 'official CSV summary when present; otherwise sum of published wallet rows',
  }));
}

if (process.env.TIDE_POR_IMPORT_TEST === '1') test();
else main().catch(error => { console.error(error); process.exitCode = 1; });
