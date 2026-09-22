-- ═══════════════════════════════════════════════════════════════════════════
-- 018 — CALIFORNIA GEOGRAPHY
--
-- Adds California as the canonical broad geography beneath the United States,
-- reparents existing California wine regions beneath it, and adds missing
-- canonical regions/appellations required by real-world imports.
--
-- Existing geography UUIDs are preserved.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_us         uuid;
  v_california uuid;
  v_napa       uuid;
begin
  select id into strict v_us
  from geo_regions
  where slug = 'us' and level = 'country';

  -- California is a valid broad state appellation of origin. In the current
  -- Cellar Atlas hierarchy it is represented as a region so Atlas can display
  -- and aggregate wines whose most specific known origin is California.
  insert into geo_regions (
    parent_id, level, slug, name, country_code,
    latitude, longitude,
    source, source_version, source_url, verified_on,
    centroid_precision
  )
  values (
    v_us, 'region', 'us-california', 'California', 'US',
    NULL, NULL,
    'manual-curation', 'cellar-atlas-geo-v2',
    'https://www.ttb.gov/regulated-commodities/beverage-alcohol/wine/appellations-of-origin',
    '2026-09-22', 'none'
  )
  on conflict (slug) do nothing;

  select id into strict v_california
  from geo_regions
  where slug = 'us-california';

  -- Preserve the existing region UUIDs while placing California regions
  -- beneath their correct broad geography.
  update geo_regions
  set parent_id = v_california
  where slug in (
    'us-napa',
    'us-sonoma',
    'us-central-coast',
    'us-santa-barbara',
    'us-paso-robles'
  );

  -- Lodi is an established California AVA. At the current Atlas abstraction
  -- it is represented as a region, consistent with Napa Valley and Paso Robles.
  insert into geo_regions (
    parent_id, level, slug, name, country_code,
    latitude, longitude,
    source, source_version, source_url, verified_on,
    centroid_precision
  )
  values (
    v_california, 'region', 'us-lodi', 'Lodi', 'US',
    NULL, NULL,
    'manual-curation', 'cellar-atlas-geo-v2',
    'https://www.ttb.gov/regulated-commodities/beverage-alcohol/wine/established-avas',
    '2026-09-22', 'none'
  )
  on conflict (slug) do nothing;

  select id into strict v_napa
  from geo_regions
  where slug = 'us-napa';

  -- Established Napa Valley AVAs missing from the original seed.
  insert into geo_regions (
    parent_id, level, slug, name, country_code,
    latitude, longitude,
    source, source_version, source_url, verified_on,
    centroid_precision
  )
  values
    (
      v_napa, 'appellation', 'us-atlas-peak', 'Atlas Peak', 'US',
      NULL, NULL,
      'manual-curation', 'cellar-atlas-geo-v2',
      'https://www.ttb.gov/regulated-commodities/beverage-alcohol/wine/established-avas',
      '2026-09-22', 'none'
    ),
    (
      v_napa, 'appellation', 'us-mt-veeder', 'Mt. Veeder', 'US',
      NULL, NULL,
      'manual-curation', 'cellar-atlas-geo-v2',
      'https://www.ttb.gov/regulated-commodities/beverage-alcohol/wine/established-avas',
      '2026-09-22', 'none'
    )
  on conflict (slug) do nothing;
end $$;
