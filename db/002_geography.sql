-- ═══════════════════════════════════════════════════════════════════════════
-- 002 — GEOGRAPHY
--
-- Canonical hierarchy so Atlas can aggregate reliably. Free text cannot
-- reconcile "Pauillac, Bordeaux" with "Bordeaux" with "bordeaux".
--
-- PROVENANCE IS MANDATORY. Every row must state where its data came from and
-- when it was verified. Nothing is seeded whose origin cannot be stated.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists geo_regions (
  id            uuid primary key default gen_random_uuid(),
  parent_id     uuid references geo_regions(id) on delete restrict,
  level         text not null check (level in ('country','region','subregion','appellation')),
  slug          text not null,
  name          text not null,
  country_code  char(2) not null,

  -- Centroid. Used for proportional-symbol placement, NOT for boundaries.
  latitude      numeric(9,6),
  longitude     numeric(9,6),

  -- True only where genuine polygon data exists and is licensed for use.
  -- Countries: yes, via Natural Earth. Wine regions: no — see docs/atlas.md.
  has_boundary  boolean not null default false,

  -- ── PROVENANCE (amendment 5) ──────────────────────────────────────────
  -- source identifies WHERE the information came from:
  --   'iso-3166'          ISO country codes — a published standard
  --   'natural-earth'     Natural Earth public domain dataset
  --   'manual-curation'   Hand-curated by the project. Approximate.
  source            text not null check (source in ('iso-3166','natural-earth','manual-curation')),
  source_version    text not null,
  source_url        text,
  verified_on       date not null,
  -- Honest precision statement for the centroid:
  --   'exact'        from an authoritative dataset
  --   'approximate'  hand-placed, fit for symbol positioning only
  --   'none'         no coordinate
  centroid_precision text not null default 'none'
                     check (centroid_precision in ('exact','approximate','none')),

  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists idx_geo_slug on geo_regions(slug);
create index if not exists idx_geo_parent on geo_regions(parent_id);
create index if not exists idx_geo_country on geo_regions(country_code);
create index if not exists idx_geo_level_country on geo_regions(level, country_code);

-- A country has no parent; everything else must have one.
alter table geo_regions drop constraint if exists chk_geo_hierarchy;
alter table geo_regions add constraint chk_geo_hierarchy
  check ((level = 'country') = (parent_id is null));

-- A coordinate must declare its precision, and vice versa.
alter table geo_regions drop constraint if exists chk_geo_centroid;
alter table geo_regions add constraint chk_geo_centroid
  check (
    (latitude is null and longitude is null and centroid_precision = 'none')
    or
    (latitude is not null and longitude is not null and centroid_precision <> 'none')
  );

drop trigger if exists trg_geo_touch on geo_regions;
create trigger trg_geo_touch before update on geo_regions
  for each row execute function touch_updated_at();


-- ───────────────────────────────────────────────────────────────────────────
-- Hierarchy walk: a node and all its ancestors, most specific first.
-- Atlas uses this to aggregate at any level.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function geo_ancestry(target uuid)
returns table (id uuid, level text, slug text, name text, depth integer)
language sql stable as $$
  with recursive up as (
    select g.id, g.parent_id, g.level, g.slug, g.name, 0 as depth
    from geo_regions g where g.id = target
    union all
    select g.id, g.parent_id, g.level, g.slug, g.name, up.depth + 1
    from geo_regions g join up on g.id = up.parent_id
  )
  select up.id, up.level, up.slug, up.name, up.depth from up order by up.depth;
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- RLS: reference data. Readable by any signed-in user, writable by no one
-- through the API. Changes arrive only via migration.
-- ───────────────────────────────────────────────────────────────────────────
alter table geo_regions enable row level security;

drop policy if exists "geo readable by authenticated" on geo_regions;
create policy "geo readable by authenticated" on geo_regions
  for select to authenticated using (true);

-- No insert, update or delete policy exists. Deliberate.
