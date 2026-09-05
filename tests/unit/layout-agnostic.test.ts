// @vitest-environment node

/**
 * LAYOUT AGNOSTICISM — the commercial architecture guarantee.
 *
 * The owner's 13-column staircase rack is ONE user's configuration. It must
 * never be a global default, and no application logic may assume that a user
 * has a staircase, has a rack at all, or has any particular storage shape.
 *
 * These tests exist to fail loudly if that ever stops being true.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  capacity,
  validatePosition,
  enumeratePositions,
  isPositionedType,
  type LayoutType,
} from "@/domain/storage/layout";

const ROOT = process.cwd();
const DB_DIR = join(ROOT, "db");
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
];

let db: PGlite;
let userId: string;

/** Four cellars with deliberately different storage philosophies. */
let cellarStaircase: string; // the owner's rack
let cellarGrid: string; // a plain rectangular rack
let cellarFridge: string; // fridge + shelving, no rack
let cellarNoStorage: string; // merchant only — no physical storage at all

async function mkCellar(name: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ($1,$2) returning id`,
    [name, userId],
  );
  return r.rows[0]!.id;
}

async function mkLayout(cellar: string, name: string, type: string, config: unknown) {
  const r = await db.query<{ create_storage_layout: string }>(
    `select create_storage_layout(gen_random_uuid(), $1, $2, $3, $4::jsonb)`,
    [cellar, name, type, JSON.stringify(config)],
  );
  return r.rows[0]!.create_storage_layout;
}

async function mkLocation(
  cellar: string,
  name: string,
  kind: string,
  layoutId: string | null,
  external = false,
) {
  const r = await db.query<{ create_storage_location: string }>(
    `select create_storage_location(gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [cellar, name, kind, layoutId, external],
  );
  return r.rows[0]!.create_storage_location;
}

async function mkWine(cellar: string, producer: string, name: string) {
  const r = await db.query<{ create_wine_definition: string }>(
    `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
    [cellar, JSON.stringify({ producer, name, colour: "Red" })],
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
    `insert into auth.users (email) values ('multi@test') returning id`,
  );
  userId = u.rows[0]!.id;
  await db.exec(`set test.user_id = '${userId}'`);
  for (const f of MIGRATIONS) await db.exec(sql(f));

  cellarStaircase = await mkCellar("Staircase Cellar");
  cellarGrid = await mkCellar("Grid Cellar");
  cellarFridge = await mkCellar("Fridge Cellar");
  cellarNoStorage = await mkCellar("Merchant Only Cellar");
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════
// STATIC ANALYSIS — the staircase must not exist in product code
// ═══════════════════════════════════════════════════════════════════════════

describe("the owner's rack is not baked into the product", () => {
  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) sourceFiles(rel, acc);
      else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(rel);
    }
    return acc;
  }

  const productFiles = sourceFiles("src").filter((f) => !f.includes("/fixtures/"));

  it("no product file contains the owner's heights array", () => {
    for (const f of productFiles) {
      const s = readFileSync(join(ROOT, f), "utf8");
      expect(s, `${f} contains the owner's rack geometry`).not.toMatch(
        /\[\s*4\s*,\s*5\s*,\s*6\s*,\s*7\s*,\s*8\s*,\s*9\s*,\s*10/,
      );
    }
  });

  it("no product file hard-codes capacity 130 or 13 columns", () => {
    for (const f of productFiles) {
      const s = readFileSync(join(ROOT, f), "utf8");
      expect(s, `${f} hard-codes 130`).not.toMatch(/capacity\s*[:=]\s*130\b/);
      expect(s, `${f} hard-codes 13 columns`).not.toMatch(/columns\s*[:=]\s*13\b/);
    }
  });

  /**
   * The behavioural version of "no migration seeds storage". A static grep is
   * unreliable here — 012_mutation_functions.sql legitimately contains
   * `insert into storage_layouts` INSIDE create_storage_layout(), which is the
   * API every user calls. What matters is that applying the migrations to an
   * empty database creates zero storage rows.
   */
  it("applying all migrations to an empty database creates ZERO storage rows", async () => {
    const fresh = new PGlite();
    await fresh.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
      end $$;
      create schema if not exists auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create or replace function auth.uid() returns uuid
        language sql stable as $$ select current_setting('test.user_id', true)::uuid $$;
    `);
    for (const f of MIGRATIONS) await fresh.exec(sql(f));

    const layouts = await fresh.query<{ c: string }>(
      `select count(*)::text c from storage_layouts`,
    );
    const locations = await fresh.query<{ c: string }>(
      `select count(*)::text c from storage_locations`,
    );
    const cellars = await fresh.query<{ c: string }>(
      `select count(*)::text c from cellars`,
    );

    expect(Number(layouts.rows[0]!.c), "migrations seeded a storage layout").toBe(0);
    expect(Number(locations.rows[0]!.c), "migrations seeded a storage location").toBe(0);
    expect(Number(cellars.rows[0]!.c), "migrations seeded a cellar").toBe(0);

    // Geography IS seeded — that is reference data, not user storage.
    const geo = await fresh.query<{ c: string }>(
      `select count(*)::text c from geo_regions`,
    );
    expect(Number(geo.rows[0]!.c)).toBeGreaterThan(150);
  }, 60_000);

  it("no NON-FUNCTION migration file inserts storage rows", () => {
    // 012 defines the API and legitimately contains INSERT inside function
    // bodies. Every other migration must be free of storage inserts entirely.
    for (const f of readdirSync(DB_DIR).filter((x) => x.endsWith(".sql"))) {
      if (f.includes("reset") || f.includes("012_mutation_functions")) continue;
      const content = sql(f);
      expect(content, `${f} inserts a storage layout`).not.toMatch(
        /insert\s+into\s+storage_layouts/i,
      );
      expect(content, `${f} inserts a storage location`).not.toMatch(
        /insert\s+into\s+storage_locations/i,
      );
    }
  });

  it("no migration mentions the owner's merchants", () => {
    for (const f of readdirSync(DB_DIR).filter((x) => x.endsWith(".sql"))) {
      if (f.includes("reset")) continue; // reset must name them to clean up
      expect(sql(f), `${f} names a merchant`).not.toMatch(/Berry Bros|Wine Society/);
    }
  });

  it("no layout type receives special-case branching", () => {
    for (const f of productFiles) {
      const s = readFileSync(join(ROOT, f), "utf8");
      // A switch over LayoutType is fine. An `if (type === "staircase")`
      // outside the dispatch is not.
      const specialCases = s.match(/if\s*\([^)]*===\s*["']staircase["']/g) ?? [];
      expect(specialCases, `${f} special-cases staircase`).toHaveLength(0);
    }
  });

  it("all six layout types are handled as peers", () => {
    const types: LayoutType[] = [
      "staircase",
      "grid",
      "shelving",
      "fridge",
      "unpositioned",
      "external",
    ];
    for (const t of types) {
      // Every type must answer capacity without throwing.
      expect(() => capacity(t, sampleConfig(t))).not.toThrow();
    }
  });
});

function sampleConfig(t: LayoutType): Record<string, unknown> {
  switch (t) {
    case "staircase":
      return {
        columns: 3,
        heights: [2, 3, 4],
        chamfer: false,
        orientation: "ascending-right",
      };
    case "grid":
      return { rows: 3, columns: 4 };
    case "shelving":
      return { shelves: [6, 6, 4] };
    case "fridge":
      return { zones: [{ name: "A", shelves: 2, perShelf: 5 }] };
    default:
      return {};
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A CELLAR MAY HAVE NO RACK AT ALL
// ═══════════════════════════════════════════════════════════════════════════

describe("a cellar can exist with no rack", () => {
  it("has no storage locations at all and remains valid", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from storage_locations where cellar_id=$1`,
      [cellarNoStorage],
    );
    expect(Number(r.rows[0]!.c)).toBe(0);

    // A wine can still be defined with nowhere to put it.
    const wine = await mkWine(cellarNoStorage, "Nowhere Estate", "Homeless Red");
    expect(wine).toBeTruthy();
  });

  it("accepts bottles with no storage location whatsoever", async () => {
    const wine = await mkWine(cellarNoStorage, "Nowhere Estate", "Unplaced Red");
    const b = await db.query<{ id: string; storage_location_id: string | null }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, storage_location_id`,
      [cellarNoStorage, wine, userId],
    );
    expect(b.rows[0]!.storage_location_id).toBeNull();
  });

  it("supports merchant-only storage with no layout", async () => {
    const merchant = await mkLocation(
      cellarNoStorage,
      "Some Merchant",
      "merchant",
      null,
      true,
    );
    const r = await db.query<{ storage_layout_id: string | null }>(
      `select storage_layout_id from storage_locations where id=$1`,
      [merchant],
    );
    expect(r.rows[0]!.storage_layout_id).toBeNull();

    const wine = await mkWine(cellarNoStorage, "Bonded Estate", "In Bond Red");
    await db.query(
      `select create_acquisition_with_items(gen_random_uuid(), $1, $2::jsonb, $3::jsonb)`,
      [
        cellarNoStorage,
        JSON.stringify({ source: "Some Merchant" }),
        JSON.stringify([
          { wine_definition_id: wine, quantity: 6, storage_location_id: merchant },
        ]),
      ],
    );

    const bottles = await db.query<{ c: string }>(
      `select count(*)::text c from bottles
       where storage_location_id=$1 and position_key is null`,
      [merchant],
    );
    expect(Number(bottles.rows[0]!.c)).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DIFFERENT CELLARS, DIFFERENT LAYOUTS
// ═══════════════════════════════════════════════════════════════════════════

describe("different cellars use different layout types", () => {
  let staircaseLayout: string, gridLayout: string;
  let fridgeLayout: string, shelvingLayout: string;

  beforeAll(async () => {
    staircaseLayout = await mkLayout(cellarStaircase, "Staircase Rack", "staircase", {
      columns: 13,
      heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      chamfer: true,
      orientation: "ascending-right",
    });

    gridLayout = await mkLayout(cellarGrid, "Wall Rack", "grid", { rows: 8, columns: 12 });

    fridgeLayout = await mkLayout(cellarFridge, "Wine Fridge", "fridge", {
      zones: [
        { name: "Upper", shelves: 4, perShelf: 8, tempC: 12 },
        { name: "Lower", shelves: 3, perShelf: 10, tempC: 16 },
      ],
    });

    shelvingLayout = await mkLayout(cellarFridge, "Pantry Shelving", "shelving", {
      shelves: [12, 12, 8, 6],
    });
  });

  it("staircase capacity is derived, not assumed: 130", async () => {
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id=$1`,
      [staircaseLayout],
    );
    expect(r.rows[0]!.capacity).toBe(130);
  });

  it("grid capacity is derived independently: 96", async () => {
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id=$1`,
      [gridLayout],
    );
    expect(r.rows[0]!.capacity).toBe(8 * 12);
  });

  it("fridge capacity is derived from its zones: 62", async () => {
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id=$1`,
      [fridgeLayout],
    );
    expect(r.rows[0]!.capacity).toBe(4 * 8 + 3 * 10);
  });

  it("shelving capacity handles non-uniform shelves: 38", async () => {
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id=$1`,
      [shelvingLayout],
    );
    expect(r.rows[0]!.capacity).toBe(38);
  });

  it("four cellars hold four different layout types", async () => {
    const r = await db.query<{ type: string; c: string }>(
      `select type, count(*)::text c from storage_layouts group by type order by type`,
    );
    const byType = Object.fromEntries(r.rows.map((x) => [x.type, Number(x.c)]));
    expect(Object.keys(byType).sort()).toEqual(["fridge", "grid", "shelving", "staircase"]);
  });

  it("one cellar can hold multiple layouts and locations", async () => {
    await mkLocation(cellarFridge, "Kitchen Fridge", "fridge", fridgeLayout);
    await mkLocation(cellarFridge, "Pantry", "other", shelvingLayout);
    await mkLocation(cellarFridge, "Merchant Bond", "merchant", null, true);

    const r = await db.query<{ c: string }>(
      `select count(*)::text c from storage_locations where cellar_id=$1`,
      [cellarFridge],
    );
    expect(Number(r.rows[0]!.c)).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POSITIONS DERIVE FROM CONFIGURATION, NOT FROM ASSUMPTION
// ═══════════════════════════════════════════════════════════════════════════

describe("valid positions derive from each layout's own configuration", () => {
  const cases: Array<[LayoutType, Record<string, unknown>, unknown, string]> = [
    [
      "staircase",
      { columns: 3, heights: [2, 3, 4], chamfer: false, orientation: "ascending-right" },
      { col: 3, row: 4 },
      "c3r4",
    ],
    ["grid", { rows: 8, columns: 12 }, { x: 12, y: 8 }, "x12y8"],
    ["shelving", { shelves: [12, 12, 8, 6] }, { shelf: 4, index: 6 }, "s4i6"],
    [
      "fridge",
      { zones: [{ name: "A", shelves: 4, perShelf: 8 }] },
      { zone: 1, shelf: 4, index: 8 },
      "z1s4i8",
    ],
  ];

  for (const [type, config, pos, key] of cases) {
    it(`${type}: accepts its own boundary position`, () => {
      const r = validatePosition(type, config, pos);
      expect(r.valid).toBe(true);
      if (r.valid) expect(r.key).toBe(key);
    });

    it(`${type}: rejects one step beyond its boundary`, () => {
      const beyond = { ...(pos as Record<string, number>) };
      const lastKey = Object.keys(beyond).pop()!;
      beyond[lastKey] = (beyond[lastKey] as number) + 1;
      expect(validatePosition(type, config, beyond).valid).toBe(false);
    });

    it(`${type}: rejects another layout's position shape`, () => {
      const foreign = type === "grid" ? { col: 1, row: 1 } : { x: 1, y: 1 };
      expect(validatePosition(type, config, foreign).valid).toBe(false);
    });
  }

  it("a small staircase rejects positions valid in the owner's large one", () => {
    const small = {
      columns: 3,
      heights: [2, 3, 4],
      chamfer: false,
      orientation: "ascending-right" as const,
    };
    // c13r16 is valid in the owner's rack and must be invalid here.
    expect(validatePosition("staircase", small, { col: 13, row: 16 }).valid).toBe(false);
    expect(validatePosition("staircase", small, { col: 1, row: 3 }).valid).toBe(false);
  });

  it("enumeration matches derived capacity for every type", () => {
    for (const [type, config] of cases) {
      const cap = capacity(type, config);
      expect(enumeratePositions(type, config).length, `${type}`).toBe(cap);
    }
  });

  it("unpositioned types enumerate nothing and have no capacity", () => {
    for (const t of ["unpositioned", "external"] as LayoutType[]) {
      expect(capacity(t, {})).toBeNull();
      expect(enumeratePositions(t, {})).toHaveLength(0);
      expect(isPositionedType(t)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DATABASE ENFORCES THE SAME RULES, PER LAYOUT
// ═══════════════════════════════════════════════════════════════════════════

describe("the database validates against each cellar's own layout", () => {
  let gridLoc: string, gridWine: string;

  beforeAll(async () => {
    const layout = await db.query<{ id: string }>(
      `select id from storage_layouts where cellar_id=$1 and type='grid'`,
      [cellarGrid],
    );
    gridLoc = await mkLocation(cellarGrid, "Wall", "home", layout.rows[0]!.id);
    gridWine = await mkWine(cellarGrid, "Grid Estate", "Grid Red");
  });

  it("accepts a valid grid position", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, version`,
      [cellarGrid, gridWine, userId],
    );
    await db.query(`select move_bottle(gen_random_uuid(),$1,$2,$3,$4::jsonb)`, [
      b.rows[0]!.id,
      b.rows[0]!.version,
      gridLoc,
      JSON.stringify({ x: 5, y: 3 }),
    ]);

    const r = await db.query<{ position_key: string }>(
      `select position_key from bottles where id=$1`,
      [b.rows[0]!.id],
    );
    expect(r.rows[0]!.position_key).toBe("x5y3");
  });

  it("rejects a staircase position in a grid cellar", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, version`,
      [cellarGrid, gridWine, userId],
    );
    await expect(
      db.query(`select move_bottle(gen_random_uuid(),$1,$2,$3,$4::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        gridLoc,
        JSON.stringify({ col: 5, row: 3 }),
      ]),
    ).rejects.toThrow(/x must be a positive integer/);
  });

  it("rejects a position outside the grid's own bounds", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, version`,
      [cellarGrid, gridWine, userId],
    );
    await expect(
      db.query(`select move_bottle(gen_random_uuid(),$1,$2,$3,$4::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        gridLoc,
        JSON.stringify({ x: 13, y: 1 }),
      ]),
    ).rejects.toThrow(/exceeds 12 columns/);
  });

  it("rejects a duplicate occupied position in a grid", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, version`,
      [cellarGrid, gridWine, userId],
    );
    await expect(
      db.query(`select move_bottle(gen_random_uuid(),$1,$2,$3,$4::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        gridLoc,
        JSON.stringify({ x: 5, y: 3 }),
      ]),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("the same position key is legal in two different locations", async () => {
    // x5y3 is taken in cellarGrid. A different cellar's grid may use it freely.
    const otherLayout = await mkLayout(cellarFridge, "Second Grid", "grid", {
      rows: 5,
      columns: 5,
    });
    const otherLoc = await mkLocation(cellarFridge, "Second Wall", "home", otherLayout);
    const wine = await mkWine(cellarFridge, "Other Estate", "Other Red");

    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, version`,
      [cellarFridge, wine, userId],
    );
    await db.query(`select move_bottle(gen_random_uuid(),$1,$2,$3,$4::jsonb)`, [
      b.rows[0]!.id,
      b.rows[0]!.version,
      otherLoc,
      JSON.stringify({ x: 5, y: 3 }),
    ]);

    const r = await db.query<{ c: string }>(
      `select count(*)::text c from bottles where position_key='x5y3' and status='in_cellar'`,
    );
    expect(Number(r.rows[0]!.c)).toBe(2); // same key, different locations
  });

  it("rejects any position on unpositioned merchant storage", async () => {
    const merchant = await mkLocation(cellarGrid, "Grid Merchant", "merchant", null, true);
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, version`,
      [cellarGrid, gridWine, userId],
    );
    await expect(
      db.query(`select move_bottle(gen_random_uuid(),$1,$2,$3,$4::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        merchant,
        JSON.stringify({ x: 1, y: 1 }),
      ]),
    ).rejects.toThrow(/does not have slots/);
  });

  it("accepts unlimited unpositioned bottles at a merchant", async () => {
    const merchant = await db.query<{ id: string }>(
      `select id from storage_locations where cellar_id=$1 and is_external=true limit 1`,
      [cellarGrid],
    );
    await db.query(
      `select create_acquisition_with_items(gen_random_uuid(),$1,$2::jsonb,$3::jsonb)`,
      [
        cellarGrid,
        JSON.stringify({ source: "Bulk" }),
        JSON.stringify([
          {
            wine_definition_id: gridWine,
            quantity: 24,
            storage_location_id: merchant.rows[0]!.id,
          },
        ]),
      ],
    );
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from bottles
       where storage_location_id=$1 and position_key is null`,
      [merchant.rows[0]!.id],
    );
    expect(Number(r.rows[0]!.c)).toBe(24);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NO GLOBAL DEFAULT
// ═══════════════════════════════════════════════════════════════════════════

describe("there is no global default storage", () => {
  it("a brand-new cellar starts with nothing", async () => {
    const fresh = await mkCellar("Brand New Cellar");
    const layouts = await db.query<{ c: string }>(
      `select count(*)::text c from storage_layouts where cellar_id=$1`,
      [fresh],
    );
    const locations = await db.query<{ c: string }>(
      `select count(*)::text c from storage_locations where cellar_id=$1`,
      [fresh],
    );
    expect(Number(layouts.rows[0]!.c)).toBe(0);
    expect(Number(locations.rows[0]!.c)).toBe(0);
  });

  it("every layout belongs to exactly one cellar — none are shared", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from storage_layouts where cellar_id is null`,
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("no database default supplies a layout type or config", async () => {
    const r = await db.query<{ column_name: string; column_default: string | null }>(
      `select column_name, column_default from information_schema.columns
       where table_name='storage_layouts' and column_name in ('type','capacity')`,
    );
    const byCol = Object.fromEntries(r.rows.map((x) => [x.column_name, x.column_default]));
    expect(byCol.type).toBeNull(); // caller must choose
    expect(byCol.capacity).toBeNull(); // derived, never assumed
  });
});
