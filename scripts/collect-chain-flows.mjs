const OKX_ENTITY_KEY = 'okx:exchange';
const NETWORKS = [
  { network: 'BTC', asset: 'BTC', provider: 'mempool.space', base: 'https://mempool.space/api', limit: 25 },
  { network: 'ETH', asset: 'ETH', provider: 'Blockscout', base: 'https://eth.blockscout.com/api/v2', limit: 50 }
];
const PER_NETWORK_PER_RUN = 4;
const MAX_CANDIDATES = 40;
const MAX_SNAPSHOT_AGE_MS = 45 * 86400000;
const PRICE_MAX_AGE_MS = 60 * 60000;
const BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const nowIso = () => new Date().toISOString();

function decimalFromUnits(value, decimals) {
  const n = BigInt(String(value || '0'));
  const negative = n < 0n;
  const absolute = negative ? -n : n;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole.toString() + (fraction ? '.' + fraction : '');
}

function parseBtcTransaction(tx, address, observedAt) {
  if (!tx || !tx.txid) return null;
  let received = 0n;
  let spent = 0n;
  (tx.vout || []).forEach(output => {
    if (String(output.scriptpubkey_address || '').toLowerCase() === address.toLowerCase()) {
      received += BigInt(String(output.value || 0));
    }
  });
  (tx.vin || []).forEach(input => {
    const prevout = input.prevout || {};
    if (String(prevout.scriptpubkey_address || '').toLowerCase() === address.toLowerCase()) {
      spent += BigInt(String(prevout.value || 0));
    }
  });
  const net = received - spent;
  if (net === 0n) return null;
  const status = tx.status || {};
  const confirmed = status.confirmed === true;
  const timestamp = confirmed && Number(status.block_time) > 0
    ? new Date(Number(status.block_time) * 1000).toISOString()
    : observedAt;
  return {
    flowKey: 'BTC:' + String(tx.txid) + ':' + address.toLowerCase(),
    txHash: String(tx.txid),
    direction: net > 0n ? 'in' : 'out',
    amount: decimalFromUnits(net > 0n ? net : -net, 8),
    occurredAt: timestamp,
    blockHeight: confirmed && Number.isFinite(Number(status.block_height)) ? Number(status.block_height) : null,
    pending: !confirmed,
    fromAccount: net < 0n ? address : null,
    toAccount: net > 0n ? address : null,
    metadata: {
      provider: 'mempool.space',
      confirmation_status: confirmed ? 'confirmed' : 'mempool_or_unconfirmed',
      time_basis: confirmed ? 'block_time' : 'first_observed',
      received_sats: received.toString(),
      spent_sats: spent.toString(),
      net_sats: net.toString(),
      address_scope: 'single_tracked_address',
      attribution_scope: 'published_exchange_wallet_sample'
    }
  };
}

function parseEthTransaction(tx, address, observedAt) {
  const from = String((tx.from && tx.from.hash) || tx.from || '').toLowerCase();
  const to = String((tx.to && tx.to.hash) || tx.to || '').toLowerCase();
  const target = address.toLowerCase();
  const txHash = String(tx.hash || tx.transaction_hash || '');
  const value = BigInt(String(tx.value || '0'));
  if (!txHash || value <= 0n || from === to || (from !== target && to !== target)) return null;
  const direction = to === target ? 'in' : 'out';
  const timestamp = tx.timestamp && Number.isFinite(Date.parse(tx.timestamp))
    ? new Date(tx.timestamp).toISOString()
    : observedAt;
  const block = Number(tx.block);
  return {
    flowKey: 'ETH:' + txHash + ':' + target,
    txHash: txHash,
    direction,
    amount: decimalFromUnits(value, 18),
    occurredAt: timestamp,
    blockHeight: Number.isSafeInteger(block) && block > 0 ? block : null,
    pending: tx.status === 'pending' || !Number.isSafeInteger(block),
    fromAccount: direction === 'out' ? address : null,
    toAccount: direction === 'in' ? address : null,
    metadata: {
      provider: 'Blockscout',
      confirmation_status: Number.isSafeInteger(block) ? 'indexed' : 'pending_or_unconfirmed',
      time_basis: tx.timestamp ? 'explorer_timestamp' : 'first_observed',
      transaction_type: tx.method || tx.type || null,
      address_scope: 'single_tracked_address',
      asset_scope: 'native_ETH_only',
      attribution_scope: 'published_exchange_wallet_sample'
    }
  };
}

function makeFlowRow(network, asset, entityId, wallet, parsed, price, observedAt) {
  const amount = Number(parsed.amount);
  const usdValue = Number.isFinite(price) && price > 0 && Number.isFinite(amount) ? amount * price : null;
  const incoming = parsed.direction === 'in';
  return {
    flow_key: parsed.flowKey,
    network,
    asset,
    flow_type: incoming ? 'exchange_inflow' : 'exchange_outflow',
    from_account_ref: parsed.fromAccount,
    to_account_ref: parsed.toAccount,
    from_entity_id: incoming ? null : entityId,
    to_entity_id: incoming ? entityId : null,
    amount: parsed.amount,
    usd_value: usdValue,
    tx_hash: parsed.txHash,
    block_height: parsed.blockHeight,
    occurred_at: parsed.occurredAt,
    observed_at: observedAt,
    attribution_confidence: Number.isFinite(Number(wallet.confidence)) ? Math.max(0, Math.min(1, Number(wallet.confidence))) : 0.95,
    source: network === 'BTC' ? 'mempool.space public API' : 'Blockscout public API',
    source_url: network === 'BTC'
      ? 'https://mempool.space/tx/' + parsed.txHash
      : 'https://eth.blockscout.com/tx/' + parsed.txHash,
    metadata: Object.assign({}, parsed.metadata, {
      entity_key: OKX_ENTITY_KEY,
      tracked_account_ref: wallet.account_ref,
      wallet_attribution_basis: 'OKX official PoR published wallet sample; role remains unknown',
      wallet_snapshot_at: wallet.snapshot_at,
      usd_value_basis: usdValue === null ? 'unavailable' : 'latest OKX spot observation within 60 minutes',
      pending: parsed.pending
    })
  };
}

async function db(table, query, options) {
  const opts = options || {};
  const response = await fetch(BASE + '/rest/v1/' + table + (query ? '?' + query : ''), {
    method: opts.method || 'GET',
    headers: {
      apikey: KEY,
      Authorization: 'Bearer ' + KEY,
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.prefer ? { Prefer: opts.prefer } : {})
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {})
  });
  const body = await response.text();
  if (!response.ok) throw new Error(table + ' HTTP ' + response.status + ': ' + body.slice(0, 300));
  return body ? JSON.parse(body) : [];
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'TideRadar-ChainFlow/1.0' } });
  const body = await response.text();
  if (!response.ok) throw new Error('Explorer HTTP ' + response.status + ': ' + body.slice(0, 180));
  return JSON.parse(body);
}

async function getPrice(asset) {
  const rows = await db('capital_market_observations',
    'select=metric_value,observed_at&venue=eq.OKX&asset=eq.' + asset +
    '&market_type=eq.spot&metric=eq.last_price&order=observed_at.desc&limit=1');
  if (!rows.length) return null;
  const age = Date.now() - Date.parse(rows[0].observed_at);
  const price = Number(rows[0].metric_value);
  return age >= 0 && age <= PRICE_MAX_AGE_MS && Number.isFinite(price) && price > 0 ? price : null;
}

async function getWalletBatch(networkConfig, entityId) {
  const snapshots = await db('capital_entity_asset_snapshots',
    'select=snapshot_at&entity_id=eq.' + entityId + '&asset=eq.' + networkConfig.asset +
    '&order=snapshot_at.desc&limit=1');
  if (!snapshots.length) return [];
  const snapshotAt = snapshots[0].snapshot_at;
  const age = Date.now() - Date.parse(snapshotAt);
  if (!(age >= 0 && age <= MAX_SNAPSHOT_AGE_MS)) {
    console.log(JSON.stringify({ network: networkConfig.network, status: 'stale_wallet_catalogue', snapshotAt }));
    return [];
  }
  const rows = await db('capital_entity_account_balances',
    'select=amount,snapshot_at,account:capital_entity_accounts!inner(id,entity_id,network,account_ref,confidence)' +
    '&account.entity_id=eq.' + entityId +
    '&account.network=eq.' + networkConfig.network +
    '&asset=eq.' + networkConfig.asset +
    '&snapshot_at=eq.' + encodeURIComponent(snapshotAt) +
    '&order=amount.desc&limit=' + MAX_CANDIDATES);
  return rows.map(row => Object.assign({}, row.account, { snapshot_at: row.snapshot_at, amount: row.amount }))
    .filter(row => row.account_ref);
}

async function getCursors(network, wallets) {
  if (!wallets.length) return new Map();
  const refs = wallets.map(x => '"' + String(x.account_ref).replace(/"/g, '') + '"').join(',');
  const rows = await db('capital_flow_cursors',
    'select=account_ref,last_txid,last_block_height,last_checked_at,cursor_status,metadata' +
    '&network=eq.' + network + '&cursor_kind=eq.transaction&account_ref=in.(' + encodeURIComponent(refs) + ')');
  return new Map(rows.map(row => [row.account_ref, row]));
}

function sortByScanAge(wallets, cursors) {
  return wallets.slice().sort((a, b) => {
    const ac = cursors.get(a.account_ref), bc = cursors.get(b.account_ref);
    const at = ac && ac.last_checked_at ? Date.parse(ac.last_checked_at) : 0;
    const bt = bc && bc.last_checked_at ? Date.parse(bc.last_checked_at) : 0;
    return at - bt || Number(b.amount || 0) - Number(a.amount || 0);
  }).slice(0, PER_NETWORK_PER_RUN);
}

async function fetchTransactions(networkConfig, address) {
  if (networkConfig.network === 'BTC') {
    const txs = await getJson(networkConfig.base + '/address/' + encodeURIComponent(address) + '/txs');
    if (!Array.isArray(txs)) throw new Error('mempool.space returned an invalid transaction list');
    return { txs, hasMore: txs.length >= 25, latestTx: txs[0] && txs[0].txid || null,
      latestBlock: txs.reduce((max, tx) => Math.max(max, Number(tx.status && tx.status.block_height) || 0), 0) };
  }
  const result = await getJson(networkConfig.base + '/addresses/' + encodeURIComponent(address) + '/transactions');
  const txs = Array.isArray(result.items) ? result.items : [];
  return { txs, hasMore: Boolean(result.next_page_params), latestTx: txs[0] && (txs[0].hash || txs[0].transaction_hash) || null,
    latestBlock: txs.reduce((max, tx) => Math.max(max, Number(tx.block) || 0), 0) };
}

async function saveCursor(network, wallet, previous, result, status, error) {
  const row = {
    network,
    account_ref: wallet.account_ref,
    cursor_kind: 'transaction',
    last_txid: result.latestTx || (previous && previous.last_txid) || null,
    last_block_height: result.latestBlock ? String(result.latestBlock) : (previous && previous.last_block_height) || null,
    last_checked_at: nowIso(),
    cursor_status: status,
    error: error ? String(error).slice(0, 300) : null,
    metadata: {
      provider: network === 'BTC' ? 'mempool.space' : 'Blockscout',
      page_limit: network === 'BTC' ? 25 : 50,
      capped_latest_page: Boolean(result.hasMore),
      wallet_snapshot_at: wallet.snapshot_at
    }
  };
  await db('capital_flow_cursors', 'on_conflict=network,account_ref,cursor_kind', {
    method: 'POST', body: [row], prefer: 'resolution=merge-duplicates,return=minimal'
  });
}

async function scanWallet(networkConfig, entityId, wallet, previous, price) {
  const observedAt = nowIso();
  const result = await fetchTransactions(networkConfig, wallet.account_ref);
  const parse = networkConfig.network === 'BTC' ? parseBtcTransaction : parseEthTransaction;
  const parsed = result.txs.map(tx => parse(tx, wallet.account_ref, observedAt)).filter(Boolean);
  const rows = parsed.map(item => makeFlowRow(networkConfig.network, networkConfig.asset, entityId, wallet, item, price, observedAt));
  if (rows.length) {
    await db('capital_flows', 'on_conflict=flow_key', {
      method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal'
    });
  }
  const cursor = previous && previous.last_txid;
  const cursorSeen = !cursor || result.txs.some(tx => String(tx.txid || tx.hash || tx.transaction_hash || '') === cursor);
  const status = result.hasMore && (!cursor || !cursorSeen) ? 'stale' : 'active';
  // If the previous cursor fell outside the explorer's capped first page, do not advance it silently.
  const cursorResult = cursor && result.hasMore && !cursorSeen
    ? Object.assign({}, result, { latestTx: cursor })
    : result;
  await saveCursor(networkConfig.network, wallet, previous, cursorResult, status);
  return { address: wallet.account_ref, transactions: result.txs.length, flows: rows.length, capped: result.hasMore, cursorSeen, status };
}

async function main() {
  if (!BASE || !KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  const entities = await db('capital_entities', 'select=id,entity_key&entity_key=eq.' + encodeURIComponent(OKX_ENTITY_KEY) + '&limit=1');
  if (!entities.length) throw new Error('OKX exchange entity not found');
  const entityId = entities[0].id;
  for (const config of NETWORKS) {
    try {
      const [wallets, price] = await Promise.all([getWalletBatch(config, entityId), getPrice(config.asset)]);
      const cursors = await getCursors(config.network, wallets);
      const selected = sortByScanAge(wallets, cursors);
      const results = [];
      for (const wallet of selected) {
        const previous = cursors.get(wallet.account_ref) || null;
        try {
          results.push(await scanWallet(config, entityId, wallet, previous, price));
        } catch (error) {
          await saveCursor(config.network, wallet, previous, { latestTx: null, latestBlock: null, hasMore: false }, 'error', error.message || error);
          results.push({ address: wallet.account_ref, status: 'error', error: String(error.message || error).slice(0, 180) });
        }
      }
      console.log(JSON.stringify({
        network: config.network, status: 'complete', candidates: wallets.length,
        scanned: results.length, priceAvailable: price !== null, results
      }));
    } catch (error) {
      console.error(config.network + ' chain flow scan failed:', error.message || error);
      process.exitCode = 1;
    }
  }
}

function test() {
  const observedAt = '2026-11-10T00:00:00.000Z';
  const address = 'bc1qtracked';
  const outgoing = parseBtcTransaction({
    txid: 'btc-out', vin: [{ prevout: { scriptpubkey_address: address, value: 25000 } }],
    vout: [{ scriptpubkey_address: 'bc1qexternal', value: 15000 }],
    status: { confirmed: true, block_height: 900, block_time: 1794268800 }
  }, address, observedAt);
  if (!outgoing || outgoing.direction !== 'out' || outgoing.amount !== '0.00025') throw new Error('BTC outflow parsing failed');
  const incoming = parseBtcTransaction({
    txid: 'btc-in', vin: [{ prevout: { scriptpubkey_address: 'bc1qexternal', value: 40000 } }],
    vout: [{ scriptpubkey_address: address, value: 30000 }],
    status: { confirmed: false }
  }, address, observedAt);
  if (!incoming || incoming.direction !== 'in' || incoming.amount !== '0.0003' || !incoming.pending) throw new Error('BTC inflow parsing failed');
  const eth = parseEthTransaction({
    hash: '0xeth', from: { hash: '0xexternal' }, to: { hash: '0xtracked' },
    value: '1000000000000000000', timestamp: observedAt, block: 123
  }, '0xtracked', observedAt);
  if (!eth || eth.direction !== 'in' || eth.amount !== '1' || eth.blockHeight !== 123) throw new Error('ETH inflow parsing failed');
  const ignored = parseEthTransaction({
    hash: '0xzero', from: { hash: '0xexternal' }, to: { hash: '0xtracked' }, value: '0'
  }, '0xtracked', observedAt);
  if (ignored !== null) throw new Error('Zero-value ETH transaction should be ignored');
  const row = makeFlowRow('ETH', 'ETH', 'entity-id', { account_ref: '0xtracked', confidence: 0.95, snapshot_at: observedAt }, eth, 3000, observedAt);
  if (row.flow_type !== 'exchange_inflow' || row.usd_value !== 3000 || row.to_entity_id !== 'entity-id') throw new Error('Flow row mapping failed');
  if (decimalFromUnits('123456789012345678901', 18) !== '123.456789012345678901') throw new Error('Exact decimal conversion failed');
  console.log('BTC/ETH chain flow tests passed: direction, exact units, pending status, attribution, and USD valuation.');
}

if (process.env.TIDE_CHAIN_FLOW_TEST === '1') test();
else main().catch(error => { console.error(error); process.exitCode = 1; });
