-- ═══════════════════════════════════════════════════════════════════════════
-- 007 — BOTTLES
--
-- ONE ROW = ONE PHYSICAL BOTTLE. There is no quantity field.
--
-- NO SOFT DELETE (amendment 3). A bottle is historical truth and never
-- disappears. `status = 'removed'` represents a mistaken or invalid inventory
-- record, and must always carry an immutable event explaining why.
--
-- SLOT UNIQUENESS uses position_key, not the JSONB position (amendment 2).
-- JSONB cannot enforce this alone: {"col":1,"row":2} and {"row":2,"col":1}
-- are different values but the same physical slot. The canonical key is
-- generated only AFTER the position has been validated against the layout,
-- so an invalid position has no key and cannot be stored.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists bottles (
  id                  uuid primary key default gen_random_uuid(),
  cellar_id           uuid not null references cellars(id) on delete cascade,

  wine_definition_id  uuid not null references wine_definitions(id) on delete restrict,
  -- Null = provenance unknown (a gift, or stock predating the app).
  acquisition_item_id uuid references acquisition_items(id) on delete set null,

  bottle_size text not null default '750ml'
              check (bottle_size in ('375ml','750ml','1500ml','3000ml','6000ml')),

  -- Location. Null once the bottle leaves inventory.
  storage_location_id uuid references storage_locations(id) on delete restrict,
  position            jsonb,      -- {col,row} | {x,y} | {shelf,index} | {zone,shelf,index}
  position_key        text,       -- canonical: 'c13r16' | 'x2y4' | 's3i7' | 'z1s2i5'

  status              text not null default 'in_cellar'
                      check (status in ('in_cellar','consumed','gifted','sold','lost','removed')),
  status_changed_at   timestamptz,

  -- Denormalised from the latest valuation_record, for fast aggregation.
  current_value       numeric(12,2) check (current_value >= 0),
  current_value_at    timestamptz,

  label_condition     text check (label_condition in ('pristine','good','damaged','missing')),
  notes               text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  updated_by  uuid references auth.users(id),
  version     integer not null default 1
  -- NOTE: no deleted_at. Bottles are never deleted. See amendment 3.
);

-- ── THE DUPLICATE-SLOT GUARANTEE ──────────────────────────────────────────
-- Only applies to bottles actually in the cellar and actually positioned.
-- Unpositioned storage (merchant, floor cases) has position_key null, and
-- nulls do not collide — so unlimited bottles coexist there.
create unique index if not exists idx_bottle_slot_unique
  on bottles (storage_location_id, position_key)
  where status = 'in_cellar' and position_key is not null;

-- A bottle out of inventory holds no location and no position.
alter table bottles drop constraint if exists chk_bottle_inactive_location;
alter table bottles add constraint chk_bottle_inactive_location
  check (
    status = 'in_cellar'
    or (storage_location_id is null and position is null and position_key is null)
  );

-- position and position_key travel together, always.
alter table bottles drop constraint if exists chk_bottle_position_pair;
alter table bottles add constraint chk_bottle_position_pair
  check ((position is null) = (position_key is null));

create index if not exists idx_bottle_active on bottles(cellar_id, status)
  where status = 'in_cellar';
create index if not exists idx_bottle_wine on bottles(wine_definition_id);
create index if not exists idx_bottle_acqitem on bottles(acquisition_item_id);
create index if not exists idx_bottle_location on bottles(storage_location_id)
  where status = 'in_cellar';
create index if not exists idx_bottle_position on bottles using gin(position);

drop trigger if exists trg_bottle_touch on bottles;
create trigger trg_bottle_touch before update on bottles
  for each row execute function touch_updated_at();
