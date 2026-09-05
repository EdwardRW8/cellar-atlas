-- ═══════════════════════════════════════════════════════════════════════════
-- 006 — ACQUISITIONS
--
-- Acquisition = one order.  AcquisitionItem = one wine line within it.
-- Purchase metadata is stored ONCE regardless of bottle count, and mixed
-- cases fall out of the model with no special case.
--
-- There is deliberately NO price field on bottles. A second place to store
-- money would eventually disagree with the first.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists acquisitions (
  id                  uuid primary key default gen_random_uuid(),
  cellar_id           uuid not null references cellars(id) on delete cascade,
  purchased_on        date,                     -- null = date unknown
  source              text,                     -- merchant name
  storage_location_id uuid references storage_locations(id) on delete set null,
  reference           text,                     -- order number
  total_amount        numeric(12,2) check (total_amount >= 0),
  currency            char(3) not null default 'GBP',
  notes               text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  version       integer not null default 1,
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id),
  delete_reason text
);

create index if not exists idx_acq_cellar on acquisitions(cellar_id, purchased_on desc)
  where deleted_at is null;

drop trigger if exists trg_acq_touch on acquisitions;
create trigger trg_acq_touch before update on acquisitions
  for each row execute function touch_updated_at();


create table if not exists acquisition_items (
  id                 uuid primary key default gen_random_uuid(),
  cellar_id          uuid not null references cellars(id) on delete cascade,
  acquisition_id     uuid not null references acquisitions(id) on delete cascade,
  wine_definition_id uuid not null references wine_definitions(id) on delete restrict,

  quantity     integer not null check (quantity > 0),
  bottle_size  text not null default '750ml'
               check (bottle_size in ('375ml','750ml','1500ml','3000ml','6000ml')),
  format       text not null default 'loose'
               check (format in ('case_12','case_6','case_3','loose')),
  unit_price   numeric(12,2) check (unit_price >= 0),
  line_total   numeric(12,2) check (line_total >= 0),
  duty_paid    boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  version       integer not null default 1,
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id),
  delete_reason text
);

create index if not exists idx_acqitem_acq on acquisition_items(acquisition_id);
create index if not exists idx_acqitem_wine on acquisition_items(wine_definition_id);

drop trigger if exists trg_acqitem_touch on acquisition_items;
create trigger trg_acqitem_touch before update on acquisition_items
  for each row execute function touch_updated_at();
