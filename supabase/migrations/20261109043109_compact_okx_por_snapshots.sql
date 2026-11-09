-- Compact, entity-level exchange reserve snapshots.
-- One row per asset/report; avoids importing every low-value address.

create table if not exists public.capital_entity_asset_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_key text not null unique,
  entity_id uuid not null references public.capital_entities(id) on delete cascade,
  asset text not null,
  reserve_amount numeric(38,18) not null check (reserve_amount >= 0),
  snapshot_at timestamptz not null,
  source text not null,
  source_url text,
  data_quality text not null default 'observed'
    check (data_quality in ('observed','partial','estimated','inferred')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(entity_id, asset, snapshot_at)
);

create index if not exists idx_capital_entity_asset_snapshots_entity_time
  on public.capital_entity_asset_snapshots(entity_id, snapshot_at desc);
create index if not exists idx_capital_entity_asset_snapshots_asset_time
  on public.capital_entity_asset_snapshots(asset, snapshot_at desc);

alter table public.capital_entity_asset_snapshots enable row level security;
revoke all on public.capital_entity_asset_snapshots from anon, authenticated;
grant all on public.capital_entity_asset_snapshots to service_role;
