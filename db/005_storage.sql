-- ═══════════════════════════════════════════════════════════════════════════
-- 005 — STORAGE
--
-- Geometry is DATA, not code. No rack is hard-coded and no storage location
-- is seeded here. Every user — including the project owner — creates their
-- own through the normal API. (Amendment 1.)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists storage_layouts (
  id            uuid primary key default gen_random_uuid(),
  cellar_id     uuid not null references cellars(id) on delete cascade,
  name          text not null,
  type          text not null check (type in
                ('staircase','grid','shelving','fridge','unpositioned','external')),
  config        jsonb not null default '{}'::jsonb,
  capacity      integer,                       -- derived; null = unbounded

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  version       integer not null default 1,
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id),
  delete_reason text
);

create index if not exists idx_layout_cellar on storage_layouts(cellar_id) where deleted_at is null;

drop trigger if exists trg_layout_touch on storage_layouts;
create trigger trg_layout_touch before update on storage_layouts
  for each row execute function touch_updated_at();


create table if not exists storage_locations (
  id                 uuid primary key default gen_random_uuid(),
  cellar_id          uuid not null references cellars(id) on delete cascade,
  name               text not null,
  kind               text not null default 'home'
                     check (kind in ('home','merchant','fridge','other')),
  storage_layout_id  uuid references storage_layouts(id) on delete restrict,
  is_external        boolean not null default false,
  merchant_reference text,
  sort_order         integer not null default 0,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  version       integer not null default 1,
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id),
  delete_reason text
);

create unique index if not exists idx_location_unique
  on storage_locations (cellar_id, lower(name)) where deleted_at is null;
create index if not exists idx_location_cellar on storage_locations(cellar_id, sort_order)
  where deleted_at is null;

drop trigger if exists trg_location_touch on storage_locations;
create trigger trg_location_touch before update on storage_locations
  for each row execute function touch_updated_at();
