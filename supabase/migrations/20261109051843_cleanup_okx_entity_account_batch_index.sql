-- Support bounded, ordered cleanup of the failed OKX PoR account rows.
-- The composite index lets the worker select the next 500 OKX IDs without
-- repeatedly scanning and filtering the full primary-key index.
create index if not exists idx_capital_entity_accounts_entity_id_id
  on public.capital_entity_accounts(entity_id, id);
