// @vitest-environment node

/**
 * PHASE 4 — FLEXIBLE STORAGE
 *
 * Run against a real Postgres engine. The two guarantees that matter are
 * tested adversarially:
 *
 *   1. A geometry change is refused if it would orphan an occupied position,
 *      INCLUDING when capacity is unchanged. Capacity comparison alone would
 *      wave through a 4x4 → 8x2 reshape that destroys half the grid.
 *
 *   2. Soft delete is refused while live bottles remain. `on delete restrict`
 *      protects only a physical DELETE; a soft delete is an UPDATE, so the
 *      foreign key never fires.
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
];

/** The owner's rack, expressed purely as configuration. */
const STAIRCASE = {
  columns: 13,
  heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  chamfer: true,
  orientation: "ascending-right",
};

let db: PGlite;
let cellarId: string;
let userId: string;
let wineId: string;

async function mkLayout(name: string, type: string, config: unknown) {
  const r = await db.query<{ create_storage_layout: string }>(
    `select create_storage_layout(gen_random_uuid(), $1, $2, $3, $4::jsonb)`,
    [cellarId, name, type, JSON.stringify(config)],
  );
  return r.rows[0]!.create_storage_layout;
}

async function mkLocation(name: string, layoutId: string | null, external = false) {
  const r = await db.query<{ create_storage_location: string }>(
    `select create_storage_location(gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [cellarId, name, external ? "merchant" : "home", layoutId, external],
  );
  return r.rows[0]!.create_storage_location;
}

async function versionOf(table: string, id: string) {
  const r = await db.query<{ version: number }>(
    `select version from ${table} where id = $1`,
    [id],
  );
  return r.rows[0]!.version;
}

async function placeBottle(locationId: string, position: unknown, key: string) {
  const r = await db.query<{ id: string }>(
    `insert into bottles (cellar_id, wine_definition_id, storage_location_id,
                          position, position_key, created_by)
     values ($1,$2,$3,$4::jsonb,$5,$6) returning id`,
    [cellarId, wineId, locationId, JSON.stringify(position), key, userId],
  );
  return r.rows[0]!.id;
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
    `insert into auth.users (email) values ('storage@test') returning id`,
  );
  userId = u.rows[0]!.id;
  await db.exec(`set test.user_id = '${userId}'`);
  for (const f of MIGRATIONS) await db.exec(sql(f));

  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Storage Test', $1) returning id`,
    [userId],
  );
  cellarId = c.rows[0]!.id;

  const w = await db.query<{ create_wine_definition: string }>(
    `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
    [cellarId, JSON.stringify({ producer: "Test", name: "Storage Wine" })],
  );
  wineId = w.rows[0]!.create_wine_definition;
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════
// STAIRCASE AS CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

describe("the owner's staircase is created through the normal API", () => {
  let layoutId: string;

  it("is created like any other layout type", async () => {
    layoutId = await mkLayout("Staircase Rack", "staircase", STAIRCASE);
    expect(layoutId).toBeTruthy();
  });

  it("capacity 130 is DERIVED, never supplied", async () => {
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id = $1`,
      [layoutId],
    );
    expect(r.rows[0]!.capacity).toBe(130);

    // Same answer from the function directly.
    const d = await db.query<{ layout_capacity: number }>(
      `select layout_capacity('staircase', $1::jsonb)`,
      [JSON.stringify(STAIRCASE)],
    );
    expect(d.rows[0]!.layout_capacity).toBe(130);
  });

  it("capacity follows the configuration, not a constant", async () => {
    const small = await mkLayout("Small Staircase", "staircase", {
      columns: 3,
      heights: [2, 3, 4],
      chamfer: false,
      orientation: "ascending-right",
    });
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id = $1`,
      [small],
    );
    expect(r.rows[0]!.capacity).toBe(9);
  });

  it("all six layout types are creatable", async () => {
    const types: [string, unknown][] = [
      ["grid", { rows: 4, columns: 4 }],
      ["shelving", { shelves: [10, 10, 8] }],
      ["fridge", { zones: [{ name: "A", shelves: 3, perShelf: 8 }] }],
      ["unpositioned", {}],
      ["external", { merchant: "Somewhere" }],
    ];
    for (const [type, config] of types) {
      const id = await mkLayout(`Test ${type}`, type, config);
      expect(id, `${type} should be creatable`).toBeTruthy();
    }
    const r = await db.query<{ c: string }>(
      `select count(distinct type)::text c from storage_layouts
       where cellar_id = $1`,
      [cellarId],
    );
    expect(Number(r.rows[0]!.c)).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GUARANTEE 1 — PER-BOTTLE GEOMETRY VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe("geometry changes are validated per bottle, not by capacity", () => {
  let gridLayout: string;
  let gridLocation: string;

  beforeAll(async () => {
    gridLayout = await mkLayout("Reshape Grid", "grid", { rows: 4, columns: 4 });
    gridLocation = await mkLocation("Reshape Wall", gridLayout);
    // A bottle at y=4 — valid in 4x4, invalid in 8x2.
    await placeBottle(gridLocation, { x: 1, y: 4 }, "x1y4");
  });

  it("THE CRITICAL CASE: a same-capacity reshape is refused", async () => {
    // 4x4 = 16 slots. 8x2 = 16 slots. Capacity comparison sees no change,
    // yet y=4 no longer exists.
    const before = await db.query<{ layout_capacity: number }>(
      `select layout_capacity('grid','{"rows":2,"columns":8}'::jsonb)`,
    );
    expect(before.rows[0]!.layout_capacity).toBe(16); // identical capacity

    await expect(
      db.query(`select update_storage_layout(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        gridLayout,
        await versionOf("storage_layouts", gridLayout),
        JSON.stringify({ config: { rows: 2, columns: 8 } }),
      ]),
    ).rejects.toThrow(/no longer exist/);
  });

  it("names the offending positions in the error", async () => {
    let message = "";
    try {
      await db.query(`select update_storage_layout(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        gridLayout,
        await versionOf("storage_layouts", gridLayout),
        JSON.stringify({ config: { rows: 2, columns: 8 } }),
      ]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/x1y4/);
    expect(message).toMatch(/Reshape Wall/);
  });

  it("nothing is changed when the update is refused", async () => {
    const r = await db.query<{ config: { rows: number }; capacity: number }>(
      `select config, capacity from storage_layouts where id = $1`,
      [gridLayout],
    );
    expect(r.rows[0]!.config.rows).toBe(4);
    expect(r.rows[0]!.capacity).toBe(16);
  });

  it("a shrink that orphans a bottle is refused", async () => {
    await expect(
      db.query(`select update_storage_layout(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        gridLayout,
        await versionOf("storage_layouts", gridLayout),
        JSON.stringify({ config: { rows: 2, columns: 4 } }),
      ]),
    ).rejects.toThrow(/no longer exist/);
  });

  it("a GROWTH that keeps every position is allowed", async () => {
    await db.query(`select update_storage_layout(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      gridLayout,
      await versionOf("storage_layouts", gridLayout),
      JSON.stringify({ config: { rows: 8, columns: 8 } }),
    ]);
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id = $1`,
      [gridLayout],
    );
    expect(r.rows[0]!.capacity).toBe(64); // recomputed, not supplied
  });

  it("a CONSUMED bottle does not block a change", async () => {
    const layout = await mkLayout("Consumed Grid", "grid", { rows: 4, columns: 4 });
    const loc = await mkLocation("Consumed Wall", layout);
    const bottle = await placeBottle(loc, { x: 1, y: 4 }, "x1y4");

    await db.query(
      `select change_bottle_status(gen_random_uuid(), $1, $2, 'consumed', now())`,
      [bottle, await versionOf("bottles", bottle)],
    );

    // The bottle is gone from inventory, so shrinking is now safe.
    await db.query(`select update_storage_layout(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      layout,
      await versionOf("storage_layouts", layout),
      JSON.stringify({ config: { rows: 2, columns: 4 } }),
    ]);
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id = $1`,
      [layout],
    );
    expect(r.rows[0]!.capacity).toBe(8);
  });

  it("a staircase reshape that removes a used column is refused", async () => {
    const layout = await mkLayout("Owner Rack", "staircase", STAIRCASE);
    const loc = await mkLocation("Owner Cellar", layout);
    await placeBottle(loc, { col: 13, row: 16 }, "c13r16");

    await expect(
      db.query(`select update_storage_layout(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        layout,
        await versionOf("storage_layouts", layout),
        JSON.stringify({
          config: {
            columns: 8,
            heights: [4, 5, 6, 7, 8, 9, 10, 11],
            chamfer: true,
            orientation: "ascending-right",
          },
        }),
      ]),
    ).rejects.toThrow(/c13r16/);
  });

  it("changing TYPE is refused when positions would not survive", async () => {
    const layout = await mkLayout("Type Change", "grid", { rows: 4, columns: 4 });
    const loc = await mkLocation("Type Change Wall", layout);
    await placeBottle(loc, { x: 2, y: 2 }, "x2y2");

    // {x,y} is meaningless to a staircase.
    await expect(
      db.query(`select update_storage_layout(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        layout,
        await versionOf("storage_layouts", layout),
        JSON.stringify({
          type: "staircase",
          config: {
            columns: 4,
            heights: [4, 4, 4, 4],
            chamfer: false,
            orientation: "ascending-right",
          },
        }),
      ]),
    ).rejects.toThrow(/no longer exist/);
  });

  it("an EMPTY layout can be reshaped freely", async () => {
    const layout = await mkLayout("Empty Grid", "grid", { rows: 4, columns: 4 });
    await db.query(`select update_storage_layout(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      layout,
      await versionOf("storage_layouts", layout),
      JSON.stringify({ config: { rows: 1, columns: 1 } }),
    ]);
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id = $1`,
      [layout],
    );
    expect(r.rows[0]!.capacity).toBe(1);
  });

  it("a RENAME skips validation entirely", async () => {
    const layout = await mkLayout("Old Name", "grid", { rows: 2, columns: 2 });
    const loc = await mkLocation("Rename Wall", layout);
    await placeBottle(loc, { x: 2, y: 2 }, "x2y2");

    await db.query(`select update_storage_layout(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      layout,
      await versionOf("storage_layouts", layout),
      JSON.stringify({ name: "New Name" }),
    ]);
    const r = await db.query<{ name: string }>(
      `select name from storage_layouts where id = $1`,
      [layout],
    );
    expect(r.rows[0]!.name).toBe("New Name");
  });

  it("layout_change_conflicts reports without changing anything", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from layout_change_conflicts(
         $1, 'grid', '{"rows":1,"columns":1}'::jsonb)`,
      [gridLayout],
    );
    expect(Number(r.rows[0]!.c)).toBe(1);

    const after = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id = $1`,
      [gridLayout],
    );
    expect(after.rows[0]!.capacity).toBe(64); // untouched
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GUARANTEE 2 — SOFT DELETE REFUSES WHILE OCCUPIED
// ═══════════════════════════════════════════════════════════════════════════

describe("soft delete refuses while live bottles remain", () => {
  let layout: string;
  let location: string;
  let bottle: string;

  beforeAll(async () => {
    layout = await mkLayout("Delete Grid", "grid", { rows: 2, columns: 2 });
    location = await mkLocation("Delete Wall", layout);
    bottle = await placeBottle(location, { x: 1, y: 1 }, "x1y1");
  });

  it("is refused, naming the location and the count", async () => {
    await expect(
      db.query(
        `select soft_delete_storage_location(gen_random_uuid(), $1, $2, 'no longer used')`,
        [location, await versionOf("storage_locations", location)],
      ),
    ).rejects.toThrow(/Delete Wall still holds 1 bottle/);
  });

  it("the location is untouched after refusal", async () => {
    const r = await db.query<{ deleted_at: string | null }>(
      `select deleted_at from storage_locations where id = $1`,
      [location],
    );
    expect(r.rows[0]!.deleted_at).toBeNull();
  });

  it("requires a reason", async () => {
    await expect(
      db.query(`select soft_delete_storage_location(gen_random_uuid(), $1, $2, '')`, [
        location,
        await versionOf("storage_locations", location),
      ]),
    ).rejects.toThrow(/requires a reason/);
  });

  it("succeeds once the bottle has left, and is SOFT", async () => {
    await db.query(
      `select change_bottle_status(gen_random_uuid(), $1, $2, 'consumed', now())`,
      [bottle, await versionOf("bottles", bottle)],
    );

    await db.query(
      `select soft_delete_storage_location(gen_random_uuid(), $1, $2, 'no longer used')`,
      [location, await versionOf("storage_locations", location)],
    );

    // Soft: the row still exists.
    const r = await db.query<{ deleted_at: string | null; delete_reason: string }>(
      `select deleted_at, delete_reason from storage_locations where id = $1`,
      [location],
    );
    expect(r.rows[0]!.deleted_at).not.toBeNull();
    expect(r.rows[0]!.delete_reason).toBe("no longer used");
  });

  it("HISTORY SURVIVES — events still reference the removed location", async () => {
    const events = await db.query<{ c: string }>(
      `select count(*)::text c from bottle_events where bottle_id = $1`,
      [bottle],
    );
    expect(Number(events.rows[0]!.c)).toBeGreaterThan(0);

    // The bottle row survives too, with its provenance intact.
    const b = await db.query<{ status: string }>(
      `select status from bottles where id = $1`,
      [bottle],
    );
    expect(b.rows[0]!.status).toBe("consumed");
  });

  it("a deleted location disappears from live listings", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from storage_locations
       where id = $1 and deleted_at is null`,
      [location],
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("a layout still used by a live location cannot be deleted", async () => {
    const l = await mkLayout("In Use", "grid", { rows: 2, columns: 2 });
    await mkLocation("Using It", l);
    await expect(
      db.query(`select soft_delete_storage_layout(gen_random_uuid(), $1, $2, 'cleanup')`, [
        l,
        await versionOf("storage_layouts", l),
      ]),
    ).rejects.toThrow(/still used by 1 storage location/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RENAME, REORDER, OCCUPANCY, IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════

describe("locations can be renamed and reordered", () => {
  let location: string;

  beforeAll(async () => {
    const l = await mkLayout("Rename Layout", "grid", { rows: 2, columns: 2 });
    location = await mkLocation("Original Name", l);
  });

  it("renames", async () => {
    await db.query(`select update_storage_location(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      location,
      await versionOf("storage_locations", location),
      JSON.stringify({ name: "Renamed Cellar" }),
    ]);
    const r = await db.query<{ name: string }>(
      `select name from storage_locations where id = $1`,
      [location],
    );
    expect(r.rows[0]!.name).toBe("Renamed Cellar");
  });

  it("reorders", async () => {
    await db.query(`select update_storage_location(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      location,
      await versionOf("storage_locations", location),
      JSON.stringify({ sort_order: 5 }),
    ]);
    const r = await db.query<{ sort_order: number }>(
      `select sort_order from storage_locations where id = $1`,
      [location],
    );
    expect(r.rows[0]!.sort_order).toBe(5);
  });

  it("refuses an empty name", async () => {
    await expect(
      db.query(`select update_storage_location(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        location,
        await versionOf("storage_locations", location),
        JSON.stringify({ name: "   " }),
      ]),
    ).rejects.toThrow(/needs a name/);
  });

  it("rejects a stale version", async () => {
    const current = await versionOf("storage_locations", location);
    await expect(
      db.query(`select update_storage_location(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        location,
        current - 1,
        JSON.stringify({ name: "Stale" }),
      ]),
    ).rejects.toThrow(/version conflict/);
  });

  it("replaying an operation applies once", async () => {
    const op = "cccccccc-0000-4000-8000-000000000001";
    const v = await versionOf("storage_locations", location);
    await db.query(`select update_storage_location($1,$2,$3,$4::jsonb)`, [
      op,
      location,
      v,
      JSON.stringify({ name: "Replayed" }),
    ]);
    // Same op id, same stale version — a no-op, not a conflict.
    await db.query(`select update_storage_location($1,$2,$3,$4::jsonb)`, [
      op,
      location,
      v,
      JSON.stringify({ name: "Replayed" }),
    ]);

    const r = await db.query<{ name: string; version: number }>(
      `select name, version from storage_locations where id = $1`,
      [location],
    );
    expect(r.rows[0]!.name).toBe("Replayed");
    expect(r.rows[0]!.version).toBe(v + 1);
  });
});

describe("occupancy is derived from configuration", () => {
  it("reports occupied, capacity, free and full for a bounded layout", async () => {
    const l = await mkLayout("Occupancy Grid", "grid", { rows: 2, columns: 2 });
    const loc = await mkLocation("Occupancy Wall", l);
    await placeBottle(loc, { x: 1, y: 1 }, "x1y1");
    await placeBottle(loc, { x: 1, y: 2 }, "x1y2");

    const r = await db.query<{
      occupied: number;
      capacity: number;
      free: number;
      is_full: boolean;
    }>(`select * from location_occupancy($1)`, [loc]);
    expect(r.rows[0]).toMatchObject({
      occupied: 2,
      capacity: 4,
      free: 2,
      is_full: false,
    });
  });

  it("reports full at capacity", async () => {
    const l = await mkLayout("Full Grid", "grid", { rows: 1, columns: 2 });
    const loc = await mkLocation("Full Wall", l);
    await placeBottle(loc, { x: 1, y: 1 }, "x1y1");
    await placeBottle(loc, { x: 2, y: 1 }, "x2y1");

    const r = await db.query<{ is_full: boolean; free: number }>(
      `select * from location_occupancy($1)`,
      [loc],
    );
    expect(r.rows[0]!.is_full).toBe(true);
    expect(r.rows[0]!.free).toBe(0);
  });

  it("unbounded storage reports NULL capacity, not zero", async () => {
    const loc = await mkLocation("Merchant", null, true);
    for (let i = 0; i < 5; i++) {
      await db.query(
        `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
         values ($1,$2,$3,$4)`,
        [cellarId, wineId, loc, userId],
      );
    }
    const r = await db.query<{
      occupied: number;
      capacity: number | null;
      free: number | null;
      is_full: boolean;
    }>(`select * from location_occupancy($1)`, [loc]);
    expect(r.rows[0]!.occupied).toBe(5);
    expect(r.rows[0]!.capacity).toBeNull();
    expect(r.rows[0]!.free).toBeNull();
    expect(r.rows[0]!.is_full).toBe(false);
  });

  it("consumed bottles do not count toward occupancy", async () => {
    const l = await mkLayout("Count Grid", "grid", { rows: 2, columns: 2 });
    const loc = await mkLocation("Count Wall", l);
    const b = await placeBottle(loc, { x: 1, y: 1 }, "x1y1");

    await db.query(
      `select change_bottle_status(gen_random_uuid(), $1, $2, 'consumed', now())`,
      [b, await versionOf("bottles", b)],
    );

    const r = await db.query<{ occupied: number; free: number }>(
      `select * from location_occupancy($1)`,
      [loc],
    );
    expect(r.rows[0]!.occupied).toBe(0);
    expect(r.rows[0]!.free).toBe(4);
  });
});

describe("migration hygiene", () => {
  it("all new functions are SECURITY INVOKER", async () => {
    const r = await db.query<{ proname: string; prosecdef: boolean }>(
      `select proname, prosecdef from pg_proc
       where pronamespace = 'public'::regnamespace
         and proname in ('update_storage_location','update_storage_layout',
                         'soft_delete_storage_location','soft_delete_storage_layout')`,
    );
    expect(r.rows).toHaveLength(4);
    expect(r.rows.every((x) => x.prosecdef === false)).toBe(true);
  });

  it("014 alters no existing table", () => {
    const s = sql("014_storage_mutations.sql");
    expect(s).not.toMatch(/alter table/i);
    expect(s).not.toMatch(/drop table/i);
    expect(s).not.toMatch(/drop policy/i);
  });

  it("014 adds no DELETE policy", () => {
    expect(sql("014_storage_mutations.sql")).not.toMatch(/for delete/i);
  });

  it("014 seeds no storage", () => {
    const s = sql("014_storage_mutations.sql");
    expect(s).not.toMatch(/insert\s+into\s+storage_layouts/i);
    expect(s).not.toMatch(/insert\s+into\s+storage_locations/i);
  });

  it("014 hard-codes no geometry", () => {
    const s = sql("014_storage_mutations.sql");
    expect(s).not.toMatch(/\b130\b/);
    expect(s).not.toMatch(/\[\s*4\s*,\s*5\s*,\s*6\s*,\s*7/);
  });

  it("RLS remains enabled on every table", async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_tables
       where schemaname='public' and rowsecurity = false`,
    );
    expect(r.rows).toEqual([]);
  });
});
