-- ═══════════════════════════════════════════════════════════════════════════
-- 004 — WINE DEFINITIONS
-- What the wine IS, independent of how many bottles you own.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists wine_definitions (
  id            uuid primary key default gen_random_uuid(),
  cellar_id     uuid not null references cellars(id) on delete cascade,

  producer      text not null,
  name          text not null,
  vintage       integer,                        -- null = non-vintage
  colour        text check (colour in ('Red','White','Rosé','Sparkling','Dessert','Fortified')),
  grapes        text[] not null default '{}',

  -- Geography: canonical node where known, free text where not.
  geo_region_id uuid references geo_regions(id) on delete set null,
  country_code  char(2),                        -- denormalised for fast filtering
  region_text   text,                           -- unmatched free text, surfaced by Atlas

  drink_from    integer,
  drink_until   integer,

  enrichment_source     text check (enrichment_source in ('manual','ai','import')),
  enrichment_confidence numeric(3,2) check (enrichment_confidence between 0 and 1),

  notes         text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  version       integer not null default 1,
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id),
  delete_reason text
);

alter table wine_definitions drop constraint if exists chk_wine_window;
alter table wine_definitions add constraint chk_wine_window
  check (drink_from is null or drink_until is null or drink_until >= drink_from);

alter table wine_definitions drop constraint if exists chk_wine_vintage;
alter table wine_definitions add constraint chk_wine_vintage
  check (vintage is null or vintage between 1800 and 2100);

-- Same wine cannot be entered twice in one cellar.
create unique index if not exists idx_wine_unique
  on wine_definitions (cellar_id, lower(producer), lower(name), coalesce(vintage, -1))
  where deleted_at is null;

create index if not exists idx_wine_cellar on wine_definitions(cellar_id) where deleted_at is null;
create index if not exists idx_wine_country on wine_definitions(cellar_id, country_code) where deleted_at is null;
create index if not exists idx_wine_geo on wine_definitions(geo_region_id);
create index if not exists idx_wine_grapes on wine_definitions using gin(grapes);

drop trigger if exists trg_wine_touch on wine_definitions;
create trigger trg_wine_touch before update on wine_definitions
  for each row execute function touch_updated_at();
