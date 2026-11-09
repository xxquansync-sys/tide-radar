module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    return res.end(JSON.stringify({ enabled: false, error: 'Method not allowed' }));
  }

  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ enabled: false, error: 'Reserve data source is not configured' }));
  }

  const root = (base.endsWith('/') ? base.slice(0, -1) : base) + '/rest/v1/';
  const headers = { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json', Prefer: 'count=exact' };
  async function read(table, query) {
    const response = await fetch(root + table + '?' + query, { headers });
    const body = await response.text();
    if (!response.ok) throw new Error(table + ' HTTP ' + response.status + ': ' + body.slice(0, 240));
    const range = response.headers.get('content-range') || '';
    const match = range.match(/\/(\d+)$/);
    return { rows: JSON.parse(body), total: match ? Number(match[1]) : null };
  }

  try {
    const entities = await read('capital_entities', 'select=id,display_name,entity_key&entity_key=eq.okx%3Aexchange&limit=1');
    const entity = entities.rows[0];
    if (!entity) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ enabled: false, error: 'OKX exchange entity was not found' }));
    }

    const snapshotResult = await read(
      'capital_entity_asset_snapshots',
      'select=asset,reserve_amount,snapshot_at,source,source_url,data_quality,metadata&entity_id=eq.' +
        encodeURIComponent(entity.id) + '&order=snapshot_at.desc&limit=500'
    );
    const latestByAsset = new Map();
    snapshotResult.rows.forEach(row => {
      const current = latestByAsset.get(row.asset);
      if (!current || Date.parse(row.snapshot_at) > Date.parse(current.snapshot_at)) latestByAsset.set(row.asset, row);
    });
    const snapshots = Array.from(latestByAsset.values()).sort((a, b) => a.asset.localeCompare(b.asset));
    const latestAt = snapshots.reduce((latest, row) =>
      !latest || Date.parse(row.snapshot_at) > Date.parse(latest) ? row.snapshot_at : latest, null
    );

    let balanceResult = { rows: [], total: 0 };
    if (latestAt) {
      balanceResult = await read(
        'capital_entity_account_balances',
        'select=asset,amount,usd_value,snapshot_at,source,data_quality,account:capital_entity_accounts!inner(network,account_ref,account_kind,account_role,entity_id)' +
          '&account.entity_id=eq.' + encodeURIComponent(entity.id) +
          '&snapshot_at=eq.' + encodeURIComponent(latestAt) +
          '&order=asset.asc,usd_value.desc.nullslast&limit=10000'
      );
    }

    const byAsset = new Map();
    balanceResult.rows.forEach(row => {
      const group = byAsset.get(row.asset) || { count: 0, wallets: [] };
      group.count++;
      if (group.wallets.length < 5) {
        const account = row.account || {};
        group.wallets.push({
          network: account.network || '',
          accountRef: account.account_ref || '',
          accountKind: account.account_kind || 'unknown',
          accountRole: account.account_role || 'unknown',
          amount: row.amount,
          usdValue: row.usd_value
        });
      }
      byAsset.set(row.asset, group);
    });

    const assets = snapshots.map(row => {
      const group = byAsset.get(row.asset) || { count: 0, wallets: [] };
      return {
        asset: row.asset,
        reserveAmount: row.reserve_amount,
        snapshotAt: row.snapshot_at,
        source: row.source,
        sourceUrl: row.source_url,
        dataQuality: row.data_quality,
        trackedWalletCount: group.count,
        topWallets: group.wallets
      };
    });

    return res.end(JSON.stringify({
      enabled: true,
      entity: entity.display_name,
      entityKey: entity.entity_key,
      snapshotAt: latestAt,
      assetCount: assets.length,
      walletRowsReturned: balanceResult.rows.length,
      walletRowsTotal: balanceResult.total,
      walletRowsTruncated: balanceResult.total !== null && balanceResult.total > balanceResult.rows.length,
      assets
    }));
  } catch (error) {
    res.statusCode = 502;
    return res.end(JSON.stringify({
      enabled: false,
      error: String(error && error.message || error).slice(0, 400)
    }));
  }
};
