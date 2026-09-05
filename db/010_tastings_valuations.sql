-- ═══════════════════════════════════════════════════════════════════════════
-- 010 — TASTINGS & VALUATIONS
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists tasting_records (
  id                 uuid primary key default gen_random_uuid(),
  cellar_id          uuid not null references cellars(id) on delete cascade,
  -- Always present, so a tasting survives independently of inventory.
  wine_definition_id uuid not null references wine_definitions(id) on delete restrict,
  -- Null when tasted elsewhere — a restaurant, a friend's cellar.
  bottle_id          uuid references bottles(id) on delete set null,
  bottle_event_id    uuid references bottle_events(id) on delete set null,

  rating    integer check (rating between 1 and 5),
  notes     text,
  tasted_on date not null default current_date,
  tasted_by uuid references auth.users(id),
  context   text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  version       integer not null default 1,
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id),
  delete_reason text
);

create index if not exists idx_tasting_wine on tasting_records(wine_definition_id)
  where deleted_at is null;
create index if not exists idx_tasting_cellar on tasting_records(cellar_id, tasted_on desc)
  where deleted_at is null;
create index if not exists idx_tasting_bottle on tasting_records(bottle_id);

drop trigger if exists trg_tasting_touch on tasting_records;
create trigger trg_tasting_touch before update on tasting_records
  for each row execute function touch_updated_at();


-- ── VALUATIONS · APPEND-ONLY ──────────────────────────────────────────────
-- Amendment 6: `source` says WHERE the number came from.
--              `valuation_basis` says WHAT KIND of number it is.
-- An auction house's realised price is source='auction_house',
-- basis='realised_sale'. A merchant's list price is source='merchant',
-- basis='merchant_retail'. Conflating the two loses meaning.
create table if not exists valuation_records (
  id        uuid primary key default gen_random_uuid(),
  cellar_id uuid not null references cellars(id) on delete cascade,

  -- Exactly one target. Value is normally per wine+vintage, but a damaged
  -- label makes one bottle worth less than its siblings.
  wine_definition_id uuid references wine_definitions(id) on delete cascade,
  bottle_id          uuid references bottles(id) on delete cascade,

  amount   numeric(12,2) not null check (amount >= 0),
  currency char(3) not null default 'GBP',

  valuation_basis text not null check (valuation_basis in (
    'market_estimate',    -- broad market view
    'merchant_retail',    -- a merchant's asking price
    'auction_estimate',   -- pre-sale estimate
    'realised_sale',      -- what it ACTUALLY sold for
    'manual_estimate'     -- the owner's own judgement
  )),

  source text not null default 'manual' check (source in (
    'manual','merchant','auction_house','api','import'
  )),

  valued_on  date not null default current_date,
  confidence numeric(3,2) check (confidence between 0 and 1),
  notes      text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

alter table valuation_records drop constraint if exists chk_valuation_target;
alter table valuation_records add constraint chk_valuation_target
  check ((wine_definition_id is null) <> (bottle_id is null));

create index if not exists idx_val_wine on valuation_records(wine_definition_id, valued_on desc);
create index if not exists idx_val_bottle on valuation_records(bottle_id, valued_on desc);

-- NOTE: append-only. No updated_at, no soft delete.
