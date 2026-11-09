-- Tide Radar capital intelligence foundation.
-- Applied to Supabase as migration capital_intelligence_foundation.

create table if not exists public.capital_entities (
  id uuid primary key default gen_random_uuid(),
  entity_key text not null unique,
  display_name text not null,
  entity_type text not null check (entity_type in ('exchange','mining_pool','miner','foundation','project_treasury','venture_fund','institutional_fund','etf_custodian','market_maker','whale_cluster','protocol','bridge','custodian','unknown_cluster')),
  identity_status text not null default 'inferred' check (identity_status in ('known','labeled','inferred','unverified')),
  confidence numeric(5,4) not null default 0.5000 check (confidence >= 0 and confidence <= 1),
  description text not null default '',
  tags text[] not null default '{}',
  source_refs jsonb not null default '[]'::jsonb,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.capital_entity_accounts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.capital_entities(id) on delete restrict,
  network text not null,
  account_ref text not null,
  account_kind text not null default 'wallet' check (account_kind in ('wallet','exchange_wallet','contract','exchange_account','custody_account','mining_pool_wallet','unknown')),
  account_role text not null default 'unknown' check (account_role in ('hot_wallet','cold_wallet','deposit_wallet','withdrawal_wallet','treasury','operating_wallet','miner_reward','custody','trading_account','unknown')),
  asset_scope text[] not null default '{}',
  attribution_basis text not null default '',
  confidence numeric(5,4) not null default 0.5000 check (confidence >= 0 and confidence <= 1),
  valid_from timestamptz,
  valid_to timestamptz,
  source_url text,
  source_refs jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(network, account_ref, account_kind)
);

create table if not exists public.capital_entity_account_balances (
  id uuid primary key default gen_random_uuid(),
  balance_key text not null unique,
  entity_account_id uuid not null references public.capital_entity_accounts(id) on delete cascade,
  asset text not null,
  amount numeric(38,18) not null check (amount >= 0),
  usd_value numeric(24,4),
  snapshot_at timestamptz not null,
  snapshot_height text,
  source text not null,
  source_url text,
  data_quality text not null default 'observed' check (data_quality in ('observed','partial','estimated','inferred')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(entity_account_id, asset, snapshot_at)
);

create index if not exists idx_capital_entity_balances_account_time on public.capital_entity_account_balances(entity_account_id, snapshot_at desc);
create index if not exists idx_capital_entity_balances_asset_time on public.capital_entity_account_balances(asset, snapshot_at desc);

create table if not exists public.capital_flows (
  id uuid primary key default gen_random_uuid(),
  flow_key text not null unique,
  network text not null,
  asset text not null,
  flow_type text not null check (flow_type in ('transfer','exchange_inflow','exchange_outflow','internal_wallet_move','mint','burn','bridge_in','bridge_out','unknown')),
  from_account_ref text,
  to_account_ref text,
  from_entity_id uuid references public.capital_entities(id) on delete set null,
  to_entity_id uuid references public.capital_entities(id) on delete set null,
  amount numeric(38,18) not null check (amount >= 0),
  usd_value numeric(24,4),
  tx_hash text,
  block_height bigint,
  occurred_at timestamptz not null,
  observed_at timestamptz not null default now(),
  attribution_confidence numeric(5,4) not null default 0.5000 check (attribution_confidence >= 0 and attribution_confidence <= 1),
  source text not null,
  source_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.capital_relationships (
  id uuid primary key default gen_random_uuid(),
  relationship_key text not null unique,
  source_entity_id uuid not null references public.capital_entities(id) on delete cascade,
  target_entity_id uuid not null references public.capital_entities(id) on delete cascade,
  relationship_type text not null check (relationship_type in ('ownership','common_control','funding','operational_wallet','treasury','custody','transfer_counterparty','behavioral_correlation','probable_affiliation','unknown')),
  confidence numeric(5,4) not null default 0.5000 check (confidence >= 0 and confidence <= 1),
  evidence_count integer not null default 1 check (evidence_count >= 0),
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  evidence_summary text not null default '',
  source_refs jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_entity_id <> target_entity_id)
);

create table if not exists public.capital_market_observations (
  id uuid primary key default gen_random_uuid(),
  observation_key text not null unique,
  venue text not null,
  instrument_id text not null,
  asset text not null,
  market_type text not null check (market_type in ('spot','swap','future','option','aggregate')),
  metric text not null,
  metric_value numeric(38,12) not null,
  unit text not null default '',
  observed_at timestamptz not null,
  source text not null,
  data_quality text not null default 'observed' check (data_quality in ('observed','partial','estimated','inferred')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_capital_entities_type on public.capital_entities(entity_type, identity_status);
create index if not exists idx_capital_entity_accounts_entity on public.capital_entity_accounts(entity_id);
create index if not exists idx_capital_entity_accounts_network_ref on public.capital_entity_accounts(network, account_ref);
create index if not exists idx_capital_flows_time on public.capital_flows(occurred_at desc);
create index if not exists idx_capital_flows_asset_time on public.capital_flows(asset, occurred_at desc);
create index if not exists idx_capital_flows_from_entity on public.capital_flows(from_entity_id, occurred_at desc);
create index if not exists idx_capital_flows_to_entity on public.capital_flows(to_entity_id, occurred_at desc);
create index if not exists idx_capital_relationships_source on public.capital_relationships(source_entity_id, relationship_type);
create index if not exists idx_capital_relationships_target on public.capital_relationships(target_entity_id, relationship_type);
create index if not exists idx_capital_market_observations_asset_time on public.capital_market_observations(asset, observed_at desc);
create index if not exists idx_capital_market_observations_venue_metric on public.capital_market_observations(venue, metric, observed_at desc);

alter table public.capital_entities enable row level security;
alter table public.capital_entity_accounts enable row level security;
alter table public.capital_entity_account_balances enable row level security;
alter table public.capital_flows enable row level security;
alter table public.capital_relationships enable row level security;
alter table public.capital_market_observations enable row level security;

revoke all on public.capital_entities, public.capital_entity_accounts, public.capital_entity_account_balances, public.capital_flows, public.capital_relationships, public.capital_market_observations from anon, authenticated;
grant all on public.capital_entities, public.capital_entity_accounts, public.capital_entity_account_balances, public.capital_flows, public.capital_relationships, public.capital_market_observations to service_role;
