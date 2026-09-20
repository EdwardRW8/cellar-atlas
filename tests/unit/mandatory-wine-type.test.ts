// @vitest-environment node

/**
 * CLEANUP A — MANDATORY WINE TYPE
 *
 * Production use showed a wine could be created with no type. Migration 016
 * closes that at the mutation boundary, where the UI cannot bypass it.
 *
 * The hard constraint: existing typeless wines must stay readable and
 * correctable. A NOT NULL column would have made them unusable.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = join(process.cwd(), "db");
const sql = (f: string) => readFileSync(join(DB_DIR, f), "utf8");

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
  "014_storage_mutations.sql",
  "015_tasting_mutations.sql",
];

let db: PGlite;
let cellarId: string;
let userId: string;
/** Created BEFORE 016, with no type — exactly like production legacy rows. */
let legacyWineId: string;

async function versionOf(id: string): Promise<number> {
  const r = await db.query<{ version: number }>(
    `select version from wine_definitions where id = $1`,
    [id],
  );
  return r.rows[0]!.version;
}

async function createWine(wine: Record<string, unknown>): Promise<string> {
  const r = await db.query<{ create_wine_definition: string }>(
    `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
    [cellarId, JSON.stringify(wine)],
  );
  return r.rows[0]!.create_wine_definition;
}

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
    `insert into auth.users (email) values ('editor@test') returning id`,
  );
  userId = u.rows[0]!.id;
  await db.exec(`set test.user_id = '${userId}'`);

  // Everything EXCEPT 016 first, so a legacy typeless wine can be created
  // exactly as the old code allowed.
  for (const f of MIGRATIONS) await db.exec(sql(f));

  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Edit Test', $1) returning id`,
    [userId],
  );
  cellarId = c.rows[0]!.id;

  legacyWineId = await createWine({
    producer: "Legacy Estate",
    name: "Untyped Wine",
    vintage: 2015,
    // No colour — the old behaviour.
  });

  const before = await db.query<{ colour: string | null }>(
    `select colour from wine_definitions where id = $1`,
    [legacyWineId],
  );
  expect(before.rows[0]!.colour, "legacy wine should have no type").toBeNull();

  // NOW apply 016.
  await db.exec(sql("016_mandatory_wine_type.sql"));
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY ROWS SURVIVE
// ═══════════════════════════════════════════════════════════════════════════

describe("existing typeless wines remain usable", () => {
  it("016 APPLIES CLEANLY despite null-colour rows", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from wine_definitions where colour is null`,
    );
    expect(Number(r.rows[0]!.c)).toBe(1);
  });

  it("the legacy wine is still readable", async () => {
    const r = await db.query<{ producer: string; colour: string | null }>(
      `select producer, colour from wine_definitions where id = $1`,
      [legacyWineId],
    );
    expect(r.rows[0]!.producer).toBe("Legacy Estate");
    expect(r.rows[0]!.colour).toBeNull();
  });

  it("no type was invented for it", async () => {
    const r = await db.query<{ colour: string | null }>(
      `select colour from wine_definitions where id = $1`,
      [legacyWineId],
    );
    expect(r.rows[0]!.colour).toBeNull();
  });

  it("OTHER fields can still be corrected without supplying a type", async () => {
    await db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      legacyWineId,
      await versionOf(legacyWineId),
      JSON.stringify({ producer: "Corrected Estate" }),
    ]);

    const r = await db.query<{ producer: string }>(
      `select producer from wine_definitions where id = $1`,
      [legacyWineId],
    );
    expect(r.rows[0]!.producer).toBe("Corrected Estate");
  });

  it("its missing type CAN be supplied through Edit Wine", async () => {
    await db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      legacyWineId,
      await versionOf(legacyWineId),
      JSON.stringify({ colour: "Red" }),
    ]);

    const r = await db.query<{ colour: string }>(
      `select colour from wine_definitions where id = $1`,
      [legacyWineId],
    );
    expect(r.rows[0]!.colour).toBe("Red");
  });

  it("once corrected, it can no longer be cleared", async () => {
    await expect(
      db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        legacyWineId,
        await versionOf(legacyWineId),
        JSON.stringify({ colour: null }),
      ]),
    ).rejects.toThrow(/cannot be removed/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CREATE REQUIRES A TYPE
// ═══════════════════════════════════════════════════════════════════════════

describe("new wines require a type", () => {
  it("REJECTS creation with no colour key at all", async () => {
    await expect(createWine({ producer: "New", name: "No Type" })).rejects.toThrow(
      /wine type is required/,
    );
  });

  it("rejects an explicitly null colour", async () => {
    await expect(
      createWine({ producer: "New", name: "Null Type", colour: null }),
    ).rejects.toThrow(/wine type is required/);
  });

  it("rejects an empty colour", async () => {
    await expect(
      createWine({ producer: "New", name: "Blank", colour: "" }),
    ).rejects.toThrow(/wine type is required/);
  });

  it("rejects an unknown type rather than storing it", async () => {
    await expect(
      createWine({ producer: "New", name: "Orange", colour: "Orange" }),
    ).rejects.toThrow(/Unknown wine type/);
  });

  it("accepts every canonical type", async () => {
    for (const colour of ["Red", "White", "Rosé", "Sparkling", "Dessert", "Fortified"]) {
      const id = await createWine({ producer: "Test", name: colour, colour });
      const r = await db.query<{ colour: string }>(
        `select colour from wine_definitions where id = $1`,
        [id],
      );
      expect(r.rows[0]!.colour, colour).toBe(colour);
    }
  });

  it("nothing is inserted when validation fails", async () => {
    const before = await db.query<{ c: string }>(
      `select count(*)::text c from wine_definitions`,
    );
    await expect(createWine({ producer: "X", name: "Y" })).rejects.toThrow();
    const after = await db.query<{ c: string }>(
      `select count(*)::text c from wine_definitions`,
    );
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 016 PRESERVED EVERYTHING ELSE
// ═══════════════════════════════════════════════════════════════════════════

describe("016 preserved the original function behaviour", () => {
  it("a client-supplied id is still honoured", async () => {
    const id = "aaaaaaaa-1111-4111-8111-111111111111";
    const returned = await createWine({
      id,
      producer: "Client Id",
      name: "Wine",
      colour: "Red",
    });
    expect(returned).toBe(id);
  });

  it("enrichment columns are still written", async () => {
    const id = await createWine({
      producer: "Enriched",
      name: "Wine",
      colour: "White",
      enrichment_source: "ai",
      enrichment_confidence: 0.8,
    });
    const r = await db.query<{ enrichment_source: string; enrichment_confidence: string }>(
      `select enrichment_source, enrichment_confidence
       from wine_definitions where id = $1`,
      [id],
    );
    expect(r.rows[0]!.enrichment_source).toBe("ai");
    expect(Number(r.rows[0]!.enrichment_confidence)).toBe(0.8);
  });

  it("enrichment_source still defaults to manual", async () => {
    const id = await createWine({ producer: "Plain", name: "Wine", colour: "Red" });
    const r = await db.query<{ enrichment_source: string }>(
      `select enrichment_source from wine_definitions where id = $1`,
      [id],
    );
    expect(r.rows[0]!.enrichment_source).toBe("manual");
  });

  it("creation replay returns the ORIGINAL id, not a fresh one", async () => {
    const op = "bbbbbbbb-2222-4222-8222-222222222222";
    const first = await db.query<{ create_wine_definition: string }>(
      `select create_wine_definition($1, $2, $3::jsonb)`,
      [op, cellarId, JSON.stringify({ producer: "R", name: "Replay", colour: "Red" })],
    );
    const second = await db.query<{ create_wine_definition: string }>(
      `select create_wine_definition($1, $2, $3::jsonb)`,
      [op, cellarId, JSON.stringify({ producer: "R", name: "Replay", colour: "Red" })],
    );
    expect(second.rows[0]!.create_wine_definition).toBe(
      first.rows[0]!.create_wine_definition,
    );
  });

  it("update still rejects a stale version", async () => {
    const id = await createWine({ producer: "V", name: "Wine 1", colour: "Red" });
    await expect(
      db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        id,
        (await versionOf(id)) - 1,
        JSON.stringify({ producer: "Stale" }),
      ]),
    ).rejects.toThrow(/version conflict/);
  });

  it("update replay applies once", async () => {
    const id = await createWine({ producer: "I", name: "Wine 2", colour: "Red" });
    const op = "cccccccc-3333-4333-8333-333333333333";
    const v = await versionOf(id);
    await db.query(`select update_wine_definition($1,$2,$3,$4::jsonb)`, [
      op,
      id,
      v,
      JSON.stringify({ producer: "Once" }),
    ]);
    await db.query(`select update_wine_definition($1,$2,$3,$4::jsonb)`, [
      op,
      id,
      v,
      JSON.stringify({ producer: "Once" }),
    ]);
    expect(await versionOf(id)).toBe(v + 1);
  });

  it("update still refuses a missing wine", async () => {
    await expect(
      db.query(`select update_wine_definition(gen_random_uuid(), $1, 1, '{}'::jsonb)`, [
        "99999999-9999-4999-8999-999999999999",
      ]),
    ).rejects.toThrow(/Wine not found/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EDITING METADATA TOUCHES NOTHING ELSE
// ═══════════════════════════════════════════════════════════════════════════

describe("correcting a wine leaves bottles and history untouched", () => {
  let wineId: string;
  let bottleId: string;
  let eventsBefore: Record<string, unknown>[];
  let bottleBefore: Record<string, unknown>;

  beforeAll(async () => {
    wineId = await createWine({
      producer: "Original",
      name: "Wine",
      vintage: 2018,
      colour: "Red",
    });
    const b = await db.query<{ id: string }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id`,
      [cellarId, wineId, userId],
    );
    bottleId = b.rows[0]!.id;

    await db.query(
      `insert into bottle_events (cellar_id, bottle_id, event_type, actor_id)
       values ($1,$2,'added',$3)`,
      [cellarId, bottleId, userId],
    );

    await db.query(`select record_tasting(gen_random_uuid(), $1, $2::jsonb)`, [
      cellarId,
      JSON.stringify({
        wine_definition_id: wineId,
        bottle_id: bottleId,
        rating: 4,
      }),
    ]);

    const e = await db.query<Record<string, unknown>>(
      `select * from bottle_events where bottle_id = $1 order by id`,
      [bottleId],
    );
    eventsBefore = e.rows;

    const bb = await db.query<Record<string, unknown>>(
      `select * from bottles where id = $1`,
      [bottleId],
    );
    bottleBefore = bb.rows[0]!;
  });

  it("the correction applies", async () => {
    await db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      wineId,
      await versionOf(wineId),
      JSON.stringify({
        producer: "Corrected",
        name: "Renamed",
        vintage: 2019,
        colour: "White",
      }),
    ]);

    const r = await db.query<{
      producer: string;
      name: string;
      vintage: number;
      colour: string;
    }>(`select producer, name, vintage, colour from wine_definitions where id = $1`, [
      wineId,
    ]);
    expect(r.rows[0]).toMatchObject({
      producer: "Corrected",
      name: "Renamed",
      vintage: 2019,
      colour: "White",
    });
  });

  it("the WINE DEFINITION ID is unchanged", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from wine_definitions where id = $1`,
      [wineId],
    );
    expect(Number(r.rows[0]!.c)).toBe(1);
  });

  it("THE BOTTLE ROW IS BYTE IDENTICAL", async () => {
    const r = await db.query<Record<string, unknown>>(
      `select * from bottles where id = $1`,
      [bottleId],
    );
    expect(r.rows[0]).toEqual(bottleBefore);
  });

  it("the bottle still references the SAME wine definition", async () => {
    const r = await db.query<{ wine_definition_id: string }>(
      `select wine_definition_id from bottles where id = $1`,
      [bottleId],
    );
    expect(r.rows[0]!.wine_definition_id).toBe(wineId);
  });

  it("BOTTLE EVENTS ARE BYTE IDENTICAL — no history rewrite", async () => {
    const e = await db.query<Record<string, unknown>>(
      `select * from bottle_events where bottle_id = $1 order by id`,
      [bottleId],
    );
    expect(e.rows).toEqual(eventsBefore);
  });

  it("no NEW event is created by a metadata correction", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from bottle_events where bottle_id = $1`,
      [bottleId],
    );
    expect(Number(r.rows[0]!.c)).toBe(eventsBefore.length);
  });

  it("the tasting is still associated with the wine", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from tasting_records
       where wine_definition_id = $1 and deleted_at is null`,
      [wineId],
    );
    expect(Number(r.rows[0]!.c)).toBe(1);
  });

  it("no replacement wine definition was created", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from wine_definitions
       where cellar_id = $1 and name = 'Renamed'`,
      [cellarId],
    );
    expect(Number(r.rows[0]!.c)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DRINKING WINDOW
// ═══════════════════════════════════════════════════════════════════════════

describe("drinking window validation", () => {
  it("accepts a valid window", async () => {
    const id = await createWine({ producer: "W", name: "Wine 3", colour: "Red" });
    await db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      id,
      await versionOf(id),
      JSON.stringify({ drink_from: 2025, drink_until: 2040 }),
    ]);

    const r = await db.query<{ drink_from: number; drink_until: number }>(
      `select drink_from, drink_until from wine_definitions where id = $1`,
      [id],
    );
    expect(r.rows[0]).toMatchObject({ drink_from: 2025, drink_until: 2040 });
  });

  it("REJECTS a window that closes before it opens", async () => {
    const id = await createWine({ producer: "W", name: "Wine 4", colour: "Red" });
    await expect(
      db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        id,
        await versionOf(id),
        JSON.stringify({ drink_from: 2040, drink_until: 2025 }),
      ]),
    ).rejects.toThrow(/cannot be later than/);
  });

  it("accepts equal years", async () => {
    const id = await createWine({ producer: "W", name: "Wine 5", colour: "Red" });
    await db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      id,
      await versionOf(id),
      JSON.stringify({ drink_from: 2030, drink_until: 2030 }),
    ]);
    const r = await db.query<{ drink_from: number }>(
      `select drink_from from wine_definitions where id = $1`,
      [id],
    );
    expect(r.rows[0]!.drink_from).toBe(2030);
  });

  it("allows an open-ended window", async () => {
    const id = await createWine({ producer: "W", name: "Wine 6", colour: "Red" });
    await db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      id,
      await versionOf(id),
      JSON.stringify({ drink_from: 2030, drink_until: null }),
    ]);
    const r = await db.query<{ drink_until: number | null }>(
      `select drink_until from wine_definitions where id = $1`,
      [id],
    );
    expect(r.rows[0]!.drink_until).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GEOGRAPHY
// ═══════════════════════════════════════════════════════════════════════════

describe("geography edits use canonical ids", () => {
  it("stores a canonical geo_region_id", async () => {
    const region = await db.query<{ id: string; country_code: string }>(
      `select id, country_code from geo_regions where level = 'region' limit 1`,
    );
    const id = await createWine({ producer: "G", name: "Wine 7", colour: "Red" });

    await db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      id,
      await versionOf(id),
      JSON.stringify({
        geo_region_id: region.rows[0]!.id,
        country_code: region.rows[0]!.country_code,
      }),
    ]);

    const r = await db.query<{ geo_region_id: string }>(
      `select geo_region_id from wine_definitions where id = $1`,
      [id],
    );
    expect(r.rows[0]!.geo_region_id).toBe(region.rows[0]!.id);
  });

  it("free text is kept separate from canonical ids", async () => {
    const id = await createWine({ producer: "G", name: "Wine 8", colour: "Red" });
    await db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      id,
      await versionOf(id),
      JSON.stringify({ geo_region_id: null, region_text: "Somewhere Unlisted" }),
    ]);

    const r = await db.query<{ geo_region_id: string | null; region_text: string }>(
      `select geo_region_id, region_text from wine_definitions where id = $1`,
      [id],
    );
    expect(r.rows[0]!.geo_region_id).toBeNull();
    expect(r.rows[0]!.region_text).toBe("Somewhere Unlisted");
  });

  it("no parallel geography row is ever created", async () => {
    const before = await db.query<{ c: string }>(
      `select count(*)::text c from geo_regions`,
    );
    const id = await createWine({ producer: "G", name: "Wine 9", colour: "Red" });
    await db.query(`select update_wine_definition(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      id,
      await versionOf(id),
      JSON.stringify({ region_text: "Invented Place" }),
    ]);
    const after = await db.query<{ c: string }>(`select count(*)::text c from geo_regions`);
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION HYGIENE
// ═══════════════════════════════════════════════════════════════════════════

describe("migration 016 hygiene", () => {
  it("both functions remain SECURITY INVOKER", async () => {
    const r = await db.query<{ proname: string; prosecdef: boolean }>(
      `select proname, prosecdef from pg_proc
       where pronamespace = 'public'::regnamespace
         and proname in ('create_wine_definition','update_wine_definition',
                         'is_valid_wine_colour')`,
    );
    expect(r.rows).toHaveLength(3);
    expect(r.rows.every((x) => x.prosecdef === false)).toBe(true);
  });

  it("016 adds no table, column or constraint", () => {
    // Strip comments first: the header deliberately EXPLAINS why
    // `alter table ... set not null` was rejected, and matching prose would
    // flag the explanation as if it were the thing it warns against.
    const executable = sql("016_mandatory_wine_type.sql")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(executable).not.toMatch(/alter table/i);
    expect(executable).not.toMatch(/create table/i);
    expect(executable).not.toMatch(/set not null/i);
    expect(executable).not.toMatch(/drop table|drop function|drop policy/i);
  });

  it("016 touches no policy", () => {
    const s = sql("016_mandatory_wine_type.sql");
    expect(s).not.toMatch(/create policy|drop policy|alter policy/i);
  });

  it("016 writes no bottle_events", () => {
    const s = sql("016_mandatory_wine_type.sql");
    expect(s).not.toMatch(/insert\s+into\s+bottle_events/i);
  });

  it("016 invents no new wine type", () => {
    const s = sql("016_mandatory_wine_type.sql");
    // Exactly the six from migration 004.
    const list = s.match(/'Red','White','Rosé','Sparkling','Dessert','Fortified'/g);
    expect(list).not.toBeNull();
    expect(s).not.toMatch(/'Orange'|'Amber'|'Natural'/);
  });

  it("RLS remains enabled on every table", async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_tables
       where schemaname='public' and rowsecurity = false`,
    );
    expect(r.rows).toEqual([]);
  });
});
