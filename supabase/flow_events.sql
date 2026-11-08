create table if not exists public.flow_events (
  event_key text primary key,
  symbol text not null,
  kind text not null,
  source text not null,
  amount numeric not null default 0,
  venues text not null default '',
  trade_id text not null default '',
  ts timestamptz not null,
  price numeric not null,
  return15 numeric,
  return60 numeric,
  observed_at timestamptz not null
);
create index if not exists flow_events_ts_idx on public.flow_events (ts desc);
create index if not exists flow_events_symbol_ts_idx on public.flow_events (symbol, ts desc);
alter table public.flow_events enable row level security;
-- Keep direct client access disabled. Only the Vercel server function should use the service-role key.
revoke all on public.flow_events from anon, authenticated;

-- Cloud archive for rule-based capital behavior alerts
create table if not exists public.flow_alerts (
  alert_key text primary key,
  symbol text not null,
  alert_type text not null,
  level text not null,
  direction text not null,
  title text not null default '',
  detail text not null default '',
  venues text not null default '',
  amount numeric not null default 0,
  ts timestamptz not null,
  price numeric not null default 0,
  oi_delta numeric not null default 0
);
create index if not exists flow_alerts_ts_idx on public.flow_alerts (ts desc);
create index if not exists flow_alerts_symbol_ts_idx on public.flow_alerts (symbol, ts desc);
alter table public.flow_alerts enable row level security;
revoke all on public.flow_alerts from anon, authenticated;
