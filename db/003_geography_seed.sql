-- ═══════════════════════════════════════════════════════════════════════════
-- 003 — GEOGRAPHY SEED
--
-- PROVENANCE STATEMENT (amendment 5)
--
-- Country codes are ISO 3166-1 alpha-2 — a published international standard.
--   source = 'iso-3166', precision of the code itself is exact.
--
-- Coordinates are HAND-CURATED by this project. They are approximate centroids
-- chosen to place a proportional symbol in the right part of the map. They are
-- NOT survey data and must never be presented as boundaries.
--   source = 'manual-curation', centroid_precision = 'approximate'
--
-- Nothing is seeded whose origin cannot be stated. Where a region's location
-- could not be established with confidence it has been omitted rather than
-- guessed — an absent region is honest, a wrong one is not.
--
-- has_boundary is false throughout. Real polygons arrive in Phase 7 for
-- COUNTRIES ONLY, from Natural Earth (public domain). Wine-region boundaries
-- are not openly licensed and will not be fabricated.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── COUNTRIES ─────────────────────────────────────────────────────────────
insert into geo_regions
  (parent_id, level, slug, name, country_code, latitude, longitude,
   source, source_version, source_url, verified_on, centroid_precision, sort_order)
values
  (null,'country','fr','France','FR',46.6,2.5,'iso-3166','ISO 3166-1:2020','https://www.iso.org/iso-3166-country-codes.html','2026-01-01','approximate',1),
  (null,'country','it','Italy','IT',42.8,12.5,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',2),
  (null,'country','es','Spain','ES',40.2,-3.7,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',3),
  (null,'country','pt','Portugal','PT',39.6,-8.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',4),
  (null,'country','de','Germany','DE',50.5,9.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',5),
  (null,'country','at','Austria','AT',47.7,14.5,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',6),
  (null,'country','ch','Switzerland','CH',46.8,8.2,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',7),
  (null,'country','gr','Greece','GR',39.0,22.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',8),
  (null,'country','hu','Hungary','HU',47.0,19.5,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',9),
  (null,'country','gb','United Kingdom','GB',52.0,-1.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',10),
  (null,'country','us','United States','US',39.0,-98.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',11),
  (null,'country','ar','Argentina','AR',-34.0,-64.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',12),
  (null,'country','cl','Chile','CL',-35.0,-71.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',13),
  (null,'country','au','Australia','AU',-30.0,135.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',14),
  (null,'country','nz','New Zealand','NZ',-41.0,174.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',15),
  (null,'country','za','South Africa','ZA',-30.0,24.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',16),
  (null,'country','ro','Romania','RO',45.9,25.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',17),
  (null,'country','bg','Bulgaria','BG',42.7,25.5,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',18),
  (null,'country','hr','Croatia','HR',45.1,15.5,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',19),
  (null,'country','si','Slovenia','SI',46.1,14.8,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',20),
  (null,'country','ge','Georgia','GE',42.0,43.5,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',21),
  (null,'country','lb','Lebanon','LB',33.8,35.9,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',22),
  (null,'country','il','Israel','IL',31.5,35.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',23),
  (null,'country','ca','Canada','CA',49.5,-119.5,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',24),
  (null,'country','uy','Uruguay','UY',-34.5,-56.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',25),
  (null,'country','br','Brazil','BR',-29.0,-51.5,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',26),
  (null,'country','mx','Mexico','MX',32.0,-116.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',27),
  (null,'country','md','Moldova','MD',47.0,28.5,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',28),
  (null,'country','tr','Turkey','TR',39.0,35.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',29),
  (null,'country','cn','China','CN',37.5,104.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',30),
  (null,'country','jp','Japan','JP',36.0,138.0,'iso-3166','ISO 3166-1:2020',null,'2026-01-01','approximate',31)
on conflict (slug) do nothing;


-- ── REGIONS ───────────────────────────────────────────────────────────────
-- All coordinates hand-curated, approximate, for symbol placement only.
do $$
declare
  v_src   text := 'manual-curation';
  v_ver   text := 'cellar-atlas-geo-v1';
  v_date  date := '2026-01-01';
  v_prec  text := 'approximate';
begin
  insert into geo_regions (parent_id, level, slug, name, country_code, latitude, longitude,
                           source, source_version, verified_on, centroid_precision)
  select p.id, 'region', r.slug, r.name, p.country_code, r.lat, r.lon,
         v_src, v_ver, v_date, v_prec
  from (values
    -- FRANCE
    ('fr','fr-bordeaux','Bordeaux',44.84,-0.58),
    ('fr','fr-burgundy','Burgundy',47.05,4.84),
    ('fr','fr-champagne','Champagne',49.05,4.03),
    ('fr','fr-rhone','Rhône',44.50,4.80),
    ('fr','fr-loire','Loire',47.40,0.70),
    ('fr','fr-alsace','Alsace',48.30,7.40),
    ('fr','fr-languedoc','Languedoc',43.40,3.20),
    ('fr','fr-roussillon','Roussillon',42.70,2.90),
    ('fr','fr-provence','Provence',43.50,6.00),
    ('fr','fr-beaujolais','Beaujolais',46.10,4.60),
    ('fr','fr-jura','Jura',46.80,5.70),
    ('fr','fr-savoie','Savoie',45.60,6.00),
    ('fr','fr-corsica','Corsica',42.10,9.10),
    ('fr','fr-sud-ouest','Sud-Ouest',44.00,1.00),
    -- ITALY
    ('it','it-piedmont','Piedmont',44.70,8.00),
    ('it','it-tuscany','Tuscany',43.40,11.20),
    ('it','it-veneto','Veneto',45.50,11.80),
    ('it','it-sicily','Sicily',37.60,14.00),
    ('it','it-puglia','Puglia',40.80,16.80),
    ('it','it-campania','Campania',40.90,14.80),
    ('it','it-lombardy','Lombardy',45.50,9.80),
    ('it','it-friuli','Friuli-Venezia Giulia',46.00,13.20),
    ('it','it-trentino','Trentino-Alto Adige',46.20,11.10),
    ('it','it-marche','Marche',43.40,13.20),
    ('it','it-abruzzo','Abruzzo',42.30,13.80),
    ('it','it-umbria','Umbria',42.90,12.50),
    ('it','it-sardinia','Sardinia',40.10,9.10),
    -- SPAIN
    ('es','es-rioja','Rioja',42.40,-2.50),
    ('es','es-ribera-del-duero','Ribera del Duero',41.60,-3.70),
    ('es','es-priorat','Priorat',41.20,0.80),
    ('es','es-rias-baixas','Rías Baixas',42.40,-8.70),
    ('es','es-jerez','Jerez',36.70,-6.10),
    ('es','es-penedes','Penedès',41.40,1.70),
    ('es','es-toro','Toro',41.50,-5.40),
    ('es','es-rueda','Rueda',41.40,-4.90),
    ('es','es-navarra','Navarra',42.70,-1.60),
    ('es','es-bierzo','Bierzo',42.60,-6.60),
    -- PORTUGAL
    ('pt','pt-douro','Douro',41.20,-7.60),
    ('pt','pt-alentejo','Alentejo',38.60,-7.90),
    ('pt','pt-vinho-verde','Vinho Verde',41.50,-8.40),
    ('pt','pt-dao','Dão',40.60,-7.90),
    ('pt','pt-bairrada','Bairrada',40.40,-8.50),
    ('pt','pt-madeira','Madeira',32.70,-17.00),
    -- GERMANY
    ('de','de-mosel','Mosel',49.90,6.90),
    ('de','de-rheingau','Rheingau',50.00,8.00),
    ('de','de-pfalz','Pfalz',49.40,8.20),
    ('de','de-nahe','Nahe',49.80,7.80),
    ('de','de-baden','Baden',48.50,7.90),
    ('de','de-rheinhessen','Rheinhessen',49.80,8.20),
    ('de','de-franken','Franken',49.80,10.10),
    -- AUSTRIA
    ('at','at-wachau','Wachau',48.40,15.40),
    ('at','at-burgenland','Burgenland',47.70,16.70),
    ('at','at-kamptal','Kamptal',48.50,15.70),
    ('at','at-kremstal','Kremstal',48.40,15.60),
    ('at','at-styria','Styria',46.90,15.50),
    -- USA
    ('us','us-napa','Napa Valley',38.50,-122.30),
    ('us','us-sonoma','Sonoma',38.50,-122.80),
    ('us','us-central-coast','Central Coast',35.50,-120.70),
    ('us','us-willamette','Willamette Valley',45.20,-123.10),
    ('us','us-columbia-valley','Columbia Valley',46.30,-119.50),
    ('us','us-finger-lakes','Finger Lakes',42.60,-76.90),
    ('us','us-santa-barbara','Santa Barbara',34.60,-120.20),
    ('us','us-paso-robles','Paso Robles',35.60,-120.70),
    -- AUSTRALIA
    ('au','au-barossa','Barossa Valley',-34.50,138.90),
    ('au','au-mclaren-vale','McLaren Vale',-35.20,138.50),
    ('au','au-coonawarra','Coonawarra',-37.30,140.80),
    ('au','au-margaret-river','Margaret River',-33.90,115.10),
    ('au','au-hunter-valley','Hunter Valley',-32.80,151.30),
    ('au','au-yarra-valley','Yarra Valley',-37.70,145.50),
    ('au','au-clare-valley','Clare Valley',-33.80,138.60),
    ('au','au-eden-valley','Eden Valley',-34.60,139.10),
    ('au','au-adelaide-hills','Adelaide Hills',-34.90,138.80),
    ('au','au-tasmania','Tasmania',-42.00,147.30),
    -- NEW ZEALAND
    ('nz','nz-marlborough','Marlborough',-41.50,173.90),
    ('nz','nz-central-otago','Central Otago',-45.00,169.20),
    ('nz','nz-hawkes-bay','Hawke''s Bay',-39.60,176.80),
    ('nz','nz-martinborough','Martinborough',-41.20,175.50),
    ('nz','nz-nelson','Nelson',-41.30,173.20),
    -- ARGENTINA
    ('ar','ar-mendoza','Mendoza',-32.90,-68.80),
    ('ar','ar-uco-valley','Uco Valley',-33.70,-69.20),
    ('ar','ar-salta','Salta',-25.40,-65.40),
    ('ar','ar-patagonia','Patagonia',-39.00,-67.50),
    -- CHILE
    ('cl','cl-maipo','Maipo Valley',-33.70,-70.80),
    ('cl','cl-colchagua','Colchagua',-34.60,-71.10),
    ('cl','cl-casablanca','Casablanca',-33.30,-71.40),
    ('cl','cl-aconcagua','Aconcagua',-32.80,-70.70),
    ('cl','cl-maule','Maule',-35.70,-71.60),
    ('cl','cl-limari','Limarí',-30.60,-71.20),
    -- SOUTH AFRICA
    ('za','za-stellenbosch','Stellenbosch',-33.90,18.80),
    ('za','za-franschhoek','Franschhoek',-33.90,19.10),
    ('za','za-paarl','Paarl',-33.70,18.90),
    ('za','za-swartland','Swartland',-33.30,18.70),
    ('za','za-walker-bay','Walker Bay',-34.40,19.20),
    ('za','za-constantia','Constantia',-34.00,18.40),
    -- GREECE
    ('gr','gr-santorini','Santorini',36.40,25.40),
    ('gr','gr-nemea','Nemea',37.80,22.70),
    ('gr','gr-naoussa','Naoussa',40.60,22.10),
    -- HUNGARY
    ('hu','hu-tokaj','Tokaj',48.10,21.40),
    ('hu','hu-villany','Villány',45.90,18.50),
    -- OTHERS
    ('gb','gb-sussex','Sussex',50.90,-0.30),
    ('gb','gb-kent','Kent',51.20,0.70),
    ('gb','gb-hampshire','Hampshire',51.00,-1.30),
    ('ch','ch-valais','Valais',46.20,7.40),
    ('ch','ch-vaud','Vaud',46.50,6.60),
    ('lb','lb-bekaa','Bekaa Valley',33.80,35.90),
    ('ge','ge-kakheti','Kakheti',41.90,45.70),
    ('ca','ca-okanagan','Okanagan',49.80,-119.60),
    ('ca','ca-niagara','Niagara',43.20,-79.30),
    ('uy','uy-canelones','Canelones',-34.50,-56.30),
    ('br','br-serra-gaucha','Serra Gaúcha',-29.20,-51.50)
  ) as r(country_slug, slug, name, lat, lon)
  join geo_regions p on p.slug = r.country_slug and p.level = 'country'
  on conflict (slug) do nothing;
end $$;


-- ── APPELLATIONS ──────────────────────────────────────────────────────────
-- Only where the appellation is unambiguous and its location is well
-- established. Where confidence was lacking the appellation is omitted —
-- an absent entry is honest; a wrong one corrupts Atlas aggregation.
do $$
declare
  v_src  text := 'manual-curation';
  v_ver  text := 'cellar-atlas-geo-v1';
  v_date date := '2026-01-01';
begin
  insert into geo_regions (parent_id, level, slug, name, country_code, latitude, longitude,
                           source, source_version, verified_on, centroid_precision)
  select p.id, 'appellation', a.slug, a.name, p.country_code, a.lat, a.lon,
         v_src, v_ver, v_date, 'approximate'
  from (values
    -- BORDEAUX
    ('fr-bordeaux','fr-pauillac','Pauillac',45.20,-0.75),
    ('fr-bordeaux','fr-margaux','Margaux',45.04,-0.67),
    ('fr-bordeaux','fr-saint-julien','Saint-Julien',45.10,-0.74),
    ('fr-bordeaux','fr-saint-estephe','Saint-Estèphe',45.26,-0.77),
    ('fr-bordeaux','fr-pomerol','Pomerol',44.93,-0.19),
    ('fr-bordeaux','fr-saint-emilion','Saint-Émilion',44.89,-0.16),
    ('fr-bordeaux','fr-graves','Graves',44.70,-0.50),
    ('fr-bordeaux','fr-sauternes','Sauternes',44.53,-0.32),
    ('fr-bordeaux','fr-pessac-leognan','Pessac-Léognan',44.78,-0.60),
    -- BURGUNDY
    ('fr-burgundy','fr-chablis','Chablis',47.81,3.80),
    ('fr-burgundy','fr-cote-de-nuits','Côte de Nuits',47.20,4.95),
    ('fr-burgundy','fr-cote-de-beaune','Côte de Beaune',47.02,4.80),
    ('fr-burgundy','fr-gevrey-chambertin','Gevrey-Chambertin',47.23,4.97),
    ('fr-burgundy','fr-nuits-saint-georges','Nuits-Saint-Georges',47.13,4.95),
    ('fr-burgundy','fr-puligny-montrachet','Puligny-Montrachet',46.95,4.75),
    ('fr-burgundy','fr-meursault','Meursault',46.98,4.77),
    ('fr-burgundy','fr-pommard','Pommard',47.00,4.75),
    -- RHONE
    ('fr-rhone','fr-chateauneuf-du-pape','Châteauneuf-du-Pape',44.06,4.83),
    ('fr-rhone','fr-hermitage','Hermitage',45.07,4.83),
    ('fr-rhone','fr-cote-rotie','Côte-Rôtie',45.50,4.80),
    ('fr-rhone','fr-condrieu','Condrieu',45.46,4.77),
    ('fr-rhone','fr-cornas','Cornas',44.96,4.83),
    ('fr-rhone','fr-gigondas','Gigondas',44.19,5.00),
    -- LOIRE
    ('fr-loire','fr-sancerre','Sancerre',47.33,2.84),
    ('fr-loire','fr-vouvray','Vouvray',47.41,0.80),
    ('fr-loire','fr-chinon','Chinon',47.17,0.24),
    ('fr-loire','fr-muscadet','Muscadet',47.20,-1.50),
    -- PIEDMONT
    ('it-piedmont','it-barolo','Barolo',44.61,7.94),
    ('it-piedmont','it-barbaresco','Barbaresco',44.72,8.08),
    -- TUSCANY
    ('it-tuscany','it-chianti-classico','Chianti Classico',43.50,11.30),
    ('it-tuscany','it-montalcino','Brunello di Montalcino',43.06,11.49),
    ('it-tuscany','it-montepulciano','Vino Nobile di Montepulciano',43.10,11.78),
    ('it-tuscany','it-bolgheri','Bolgheri',43.23,10.60),
    -- VENETO
    ('it-veneto','it-valpolicella','Valpolicella',45.50,10.90),
    ('it-veneto','it-soave','Soave',45.42,11.25),
    -- LOMBARDY
    ('it-lombardy','it-franciacorta','Franciacorta',45.60,10.00),
    -- SICILY
    ('it-sicily','it-etna','Etna',37.75,15.00),
    -- USA
    ('us-napa','us-oakville','Oakville',38.44,-122.40),
    ('us-napa','us-rutherford','Rutherford',38.46,-122.42),
    ('us-napa','us-howell-mountain','Howell Mountain',38.60,-122.40),
    ('us-napa','us-stags-leap','Stags Leap District',38.41,-122.32),
    ('us-sonoma','us-russian-river','Russian River Valley',38.50,-122.90),
    ('us-columbia-valley','us-walla-walla','Walla Walla Valley',46.06,-118.30),
    -- SPAIN / PORTUGAL
    ('es-rioja','es-rioja-alta','Rioja Alta',42.45,-2.75),
    ('es-rioja','es-rioja-alavesa','Rioja Alavesa',42.55,-2.65),
    ('pt-douro','pt-cima-corgo','Cima Corgo',41.16,-7.55)
  ) as a(parent_slug, slug, name, lat, lon)
  join geo_regions p on p.slug = a.parent_slug
  on conflict (slug) do nothing;
end $$;


-- ── VERIFY ────────────────────────────────────────────────────────────────
-- select level, source, centroid_precision, count(*)
-- from geo_regions group by 1,2,3 order by 1,2;
