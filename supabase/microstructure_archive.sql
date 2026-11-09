-- Tide Radar server-side microstructure archive.
-- Run once in Supabase SQL Editor. Service-role access is used only by GitHub Actions secrets.
create table if not exists public.micro_trade_samples (
  sample_key text primary key,
  symbol text not null,
  inst_id text not null,
  trade_id text not null,
  ts timestamptz not null,
  side text not null check (side in ('buy','sell')),
  price numeric not null,
  size_contracts numeric not null,
  notional_usd numeric not null,
  observed_at timestamptz not null
);
create index if not exists micro_trade_samples_symbol_ts_idx on public.micro_trade_samples (symbol, ts desc);
create index if not exists micro_trade_samples_ts_idx on public.micro_trade_samples (ts desc);

create table if not exists public.micro_book_snapshots (
  snapshot_key text primary key,
  symbol text not null,
  inst_id text not null,
  ts timestamptz not null,
  best_bid numeric,
  best_ask numeric,
  spread_pct numeric,
  bid_depth_10_usd numeric,
  ask_depth_10_usd numeric,
  levels jsonb not null default '[]'::jsonb,
  observed_at timestamptz not null
);
create index if not exists micro_book_snapshots_symbol_ts_idx on public.micro_book_snapshots (symbol, ts desc);

create table if not exists public.micro_sample_runs (
  run_key text primary key,
  symbol text not null,
  inst_id text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  trade_rows_received integer not null default 0,
  trade_rows_valid integer not null default 0,
  trade_rows_archived integer not null default 0,
  trade_oldest_at timestamptz,
  trade_newest_at timestamptz,
  trade_coverage_seconds integer not null default 0,
  trade_coverage_status text not null default 'unavailable',
  book_snapshot_at timestamptz,
  errors jsonb not null default '{}'::jsonb,
  source text not null default 'OKX public REST'
);
create index if not exists micro_sample_runs_symbol_completed_idx on public.micro_sample_runs (symbol, completed_at desc);

alter table public.micro_trade_samples enable row level security;
alter table public.micro_book_snapshots enable row level security;
alter table public.micro_sample_runs enable row level security;
revoke all on public.micro_trade_samples from anon, authenticated;
revoke all on public.micro_book_snapshots from anon, authenticated;
revoke all on public.micro_sample_runs from anon, authenticated;
