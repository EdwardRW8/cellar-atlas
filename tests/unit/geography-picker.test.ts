// @vitest-environment node

/**
 * CANONICAL GEOGRAPHY (Phase 3 plan, restored)
 *
 * The approved plan specified a searchable picker over geo_regions storing
 * the canonical geoRegionId, with free text only as a fallback. These tests
 * verify the whole path — draft, commit payload, database round trip — plus
 * the architectural guard that the UI actually uses the picker.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { emptyDraft, setField, toCommitPayload } from "@/domain/wine-draft";

const ROOT = process.cwd();
const DB_DIR = join(ROOT, "db");
const sql = (f: string) => readFileSync(join(DB_DIR, f), "utf8");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

const MIGRATIONS = [
  "001_foundation.sql",
  "002_geography.sql",
  "003_geography_seed.sql",
  "004_wine_definitions.sql",
  "005_storage.sql",
  "006_acquisitions.sql",
  "007_bottles.sql",
  "008_position_validation.sql",
  "009_bottle_events.sql",
  "010_tastings_valuations.sql",
  "011_cellar_profile.sql",
  "012_mutation_functions.sql",
  "013_rls.sql",
];

let db: PGlite;
let cellarId: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    end $$;
    create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select current_setting('test.user_id', true)::uuid $$;
  `);
  const u = await db.query<{ id: string }>(
    `insert into auth.users (email) values ('geo@test') returning id`,
  );
  await db.exec(`set test.user_id = '${u.rows[0]!.id}'`);
  for (const f of MIGRATIONS) await db.exec(sql(f));

  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Geo', $1) returning id`,
    [u.rows[0]!.id],
  );
  cellarId = c.rows[0]!.id;
}, 60_000);

describe("the search the picker relies on", () => {
  it("finds Pauillac by name", async () => {
    const r = await db.query<{ id: string; name: string; level: string }>(
      `select id, name, level from geo_regions where name ilike '%Pauillac%'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.level).toBe("appellation");
  });

  it("finds partial matches across levels", async () => {
    const r = await db.query<{ name: string; level: string }>(
      `select name, level from geo_regions where name ilike '%bord%' order by level`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it("resolves ancestry for display — Pauillac · Bordeaux · France", async () => {
    const r = await db.query<{ name: string }>(
      `select name from geo_ancestry(
         (select id from geo_regions where slug = 'fr-pauillac')) order by depth`,
    );
    expect(r.rows.map((x) => x.name)).toEqual(["Pauillac", "Bordeaux", "France"]);
  });

  it("carries the country code on every node, for denormalisation", async () => {
    const r = await db.query<{ country_code: string }>(
      `select country_code from geo_regions where slug = 'fr-pauillac'`,
    );
    expect(r.rows[0]!.country_code).toBe("FR");
  });

  it("a two-character term is enough to match something", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from geo_regions where name ilike '%na%'`,
    );
    expect(Number(r.rows[0]!.c)).toBeGreaterThan(0);
  });
});

describe("draft carries the canonical id", () => {
  it("stores geoRegionId and countryCode, clearing regionText", () => {
    let d = emptyDraft();
    d = setField(d, "geoRegionId", "abc-123");
    d = setField(d, "countryCode", "FR");
    d = setField(d, "regionText", null);

    expect(d.identity.geoRegionId).toBe("abc-123");
    expect(d.identity.countryCode).toBe("FR");
    expect(d.identity.regionText).toBeNull();
  });

  it("free text stores regionText with NO geoRegionId", () => {
    let d = emptyDraft();
    d = setField(d, "geoRegionId", null);
    d = setField(d, "regionText", "Somewhere Unmapped");

    expect(d.identity.geoRegionId).toBeNull();
    expect(d.identity.regionText).toBe("Somewhere Unmapped");
  });

  it("records provenance for geography like any other field", () => {
    const d = setField(emptyDraft(), "geoRegionId", "abc-123");
    expect(d.provenance.geoRegionId?.source).toBe("user");
  });

  it("the commit payload sends geo_region_id", () => {
    let d = setField(emptyDraft(), "producer", "P");
    d = setField(d, "name", "N");
    d = setField(d, "geoRegionId", "abc-123");
    d = setField(d, "countryCode", "FR");

    const payload = toCommitPayload(d);
    expect(payload.wine!.geo_region_id).toBe("abc-123");
    expect(payload.wine!.country_code).toBe("FR");
  });
});

describe("the canonical id survives the round trip to the database", () => {
  it("a wine created with a real geoRegionId keeps it", async () => {
    const geo = await db.query<{ id: string }>(
      `select id from geo_regions where slug = 'fr-pauillac'`,
    );
    const geoId = geo.rows[0]!.id;

    const created = await db.query<{ create_wine_definition: string }>(
      `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
      [
        cellarId,
        JSON.stringify({
          producer: "Canonical Test",
          name: "Pauillac Wine",
          geo_region_id: geoId,
          country_code: "FR",
        }),
      ],
    );

    const wine = await db.query<{
      geo_region_id: string;
      country_code: string;
      region_text: string | null;
    }>(
      `select geo_region_id, country_code, region_text
       from wine_definitions where id = $1`,
      [created.rows[0]!.create_wine_definition],
    );

    expect(wine.rows[0]!.geo_region_id).toBe(geoId);
    expect(wine.rows[0]!.country_code).toBe("FR");
    expect(wine.rows[0]!.region_text).toBeNull();
  }, 30_000);

  it("free text is stored WITHOUT a geoRegionId", async () => {
    const created = await db.query<{ create_wine_definition: string }>(
      `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
      [
        cellarId,
        JSON.stringify({
          producer: "Freetext Test",
          name: "Unmapped Wine",
          region_text: "Somewhere Unmapped",
        }),
      ],
    );

    const wine = await db.query<{ geo_region_id: string | null; region_text: string }>(
      `select geo_region_id, region_text from wine_definitions where id = $1`,
      [created.rows[0]!.create_wine_definition],
    );

    expect(wine.rows[0]!.geo_region_id).toBeNull();
    expect(wine.rows[0]!.region_text).toBe("Somewhere Unmapped");
  }, 30_000);

  it("the FK rejects a fabricated geoRegionId", async () => {
    await expect(
      db.query(`select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`, [
        cellarId,
        JSON.stringify({
          producer: "Bad",
          name: "Bad",
          geo_region_id: "99999999-9999-4999-8999-999999999999",
        }),
      ]),
    ).rejects.toThrow(/foreign key|violates/i);
  }, 30_000);

  it("Atlas can already aggregate canonically stored wines by country", async () => {
    const r = await db.query<{ country_code: string; c: string }>(
      `select g.country_code, count(*)::text c
       from wine_definitions w
       join geo_regions g on g.id = w.geo_region_id
       where w.cellar_id = $1
       group by g.country_code`,
      [cellarId],
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0]!.country_code).toBe("FR");
  }, 30_000);

  it("wines needing geography are identifiable — Atlas's 'needs attention'", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from wine_definitions
       where cellar_id = $1 and geo_region_id is null`,
      [cellarId],
    );
    expect(Number(r.rows[0]!.c)).toBeGreaterThan(0);
  }, 30_000);
});

describe("the UI actually uses the canonical picker", () => {
  it("Add Wine imports GeographyPicker", () => {
    expect(read("src/features/add-wine/AddWineScreen.tsx")).toMatch(
      /import \{ GeographyPicker/,
    );
  });

  it("Add Wine no longer collects a raw country code", () => {
    const s = read("src/features/add-wine/AddWineScreen.tsx");
    expect(s).not.toMatch(/label="Country code"/);
    expect(s).not.toMatch(/Two letters, e\.g\. FR/);
  });

  it("the picker searches the canonical table, not free text", () => {
    const s = read("src/features/add-wine/GeographyPicker.tsx");
    expect(s).toMatch(/searchGeography/);
    expect(s).toMatch(/geoRegionId/);
  });

  it("free text remains available as an explicit fallback", () => {
    const s = read("src/features/add-wine/GeographyPicker.tsx");
    expect(s).toMatch(/useFreeText/);
    expect(s).toMatch(/as free text/i);
  });

  it("the picker distinguishes canonical from free text to the user", () => {
    const s = read("src/features/add-wine/GeographyPicker.tsx");
    expect(s).toMatch(/Matched to the wine atlas/);
    expect(s).toMatch(/not on the atlas/);
  });

  it("results show ancestry so same-named places are distinguishable", () => {
    const s = read("src/features/add-wine/GeographyPicker.tsx");
    expect(s).toMatch(/searchGeographyByIds/);
    expect(s).toMatch(/parts\.join\(" · "\)/);
  });

  it("the picker is not Atlas — it builds no map", () => {
    const files = readdirSync(join(ROOT, "src/features/add-wine"));
    for (const f of files) {
      const s = read(`src/features/add-wine/${f}`);
      expect(s, `${f} should not contain map rendering`).not.toMatch(
        /<svg|projection|choropleth|leaflet|mapbox/i,
      );
    }
  });
});
