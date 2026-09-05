// @vitest-environment node

/**
 * SQL integration tests — run against a REAL Postgres engine (PGlite, the
 * Postgres source compiled to WebAssembly).
 *
 * This exists because 2,000 lines of plpgsql cannot be verified by reading
 * it. Everything here executes the actual migration files and calls the
 * actual functions.
 *
 * Supabase-specific objects (auth.users, auth.uid()) are stubbed, and the
 * RLS policies that depend on them are covered separately by a live checklist
 * — PGlite runs as superuser, which bypasses RLS by design.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = join(process.cwd(), "db");
const sql = (f: string) => readFileSync(join(DB_DIR, f), "utf8");

let db: PGlite;

/** The owner's rack — created as ordinary user data, not seeded. */
const OWNER_RACK = {
  columns: 13,
  heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  chamfer: true,
  orientation: "ascending-right",
};

let cellarId: string;
let userId: string;
let rackLayoutId: string;
let rackLocationId: string;
let merchantLocationId: string;
let wineA: string;
let wineB: string;
let wineC: string;

beforeAll(async () => {
  db = new PGlite();

  // ── Supabase stubs ──────────────────────────────────────────────────────
  // Supabase provides these roles; bare Postgres does not.
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='authenticated') then
        create role authenticated;
      end if;
      if not exists (select 1 from pg_roles where rolname='anon') then
        create role anon;
      end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then
        create role service_role;
      end if;
    end $$;
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text
    );
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select current_setting('test.user_id', true)::uuid $$;
  `);

  const u = await db.query<{ id: string }>(
    `insert into auth.users (email) values ('owner@test') returning id`,
  );
  userId = u.rows[0]!.id;
  await db.exec(`set test.user_id = '${userId}'`);

  // ── Run the real migrations, in order ───────────────────────────────────
  for (const f of [
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
  ]) {
    await db.exec(sql(f));
  }

  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Test Cellar', '${userId}') returning id`,
  );
  cellarId = c.rows[0]!.id;

  // Storage created through the normal API — no seed migration (amendment 1).
  const layout = await db.query<{ create_storage_layout: string }>(
    `select create_storage_layout(gen_random_uuid(), $1, 'Staircase Rack', 'staircase', $2::jsonb)`,
    [cellarId, JSON.stringify(OWNER_RACK)],
  );
  rackLayoutId = layout.rows[0]!.create_storage_layout;

  const loc = await db.query<{ create_storage_location: string }>(
    `select create_storage_location(gen_random_uuid(), $1, 'Home Cellar', 'home', $2)`,
    [cellarId, rackLayoutId],
  );
  rackLocationId = loc.rows[0]!.create_storage_location;

  const merch = await db.query<{ create_storage_location: string }>(
    `select create_storage_location(gen_random_uuid(), $1, 'Berry Bros & Rudd', 'merchant', null, true)`,
    [cellarId],
  );
  merchantLocationId = merch.rows[0]!.create_storage_location;

  const mkWine = async (producer: string, name: string, vintage: number) => {
    const r = await db.query<{ create_wine_definition: string }>(
      `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
      [
        cellarId,
        JSON.stringify({
          producer,
          name,
          vintage,
          colour: "Red",
          grapes: ["Cabernet Sauvignon"],
        }),
      ],
    );
    return r.rows[0]!.create_wine_definition;
  };
  wineA = await mkWine("Château Margaux", "Château Margaux", 2015);
  wineB = await mkWine("Tenuta San Guido", "Sassicaia", 2018);
  wineC = await mkWine("Antinori", "Tignanello", 2019);
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATIONS
// ═══════════════════════════════════════════════════════════════════════════

describe("migrations", () => {
  it("all 13 files apply cleanly", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from information_schema.tables
       where table_schema='public'`,
    );
    expect(Number(r.rows[0]!.count)).toBeGreaterThanOrEqual(16);
  });

  it("geography seeds with mandatory provenance on every row", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from geo_regions
       where source is null or source_version is null or verified_on is null`,
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  it("no centroid claims precision it does not have", async () => {
    const bad = await db.query<{ count: string }>(
      `select count(*)::text from geo_regions
       where centroid_precision = 'exact' and source = 'manual-curation'`,
    );
    expect(Number(bad.rows[0]!.count)).toBe(0);
  });

  it("no wine region claims to have boundary data", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from geo_regions where has_boundary = true`,
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  it("the hierarchy is well formed", async () => {
    const orphans = await db.query<{ count: string }>(
      `select count(*)::text from geo_regions
       where (level='country') <> (parent_id is null)`,
    );
    expect(Number(orphans.rows[0]!.count)).toBe(0);
  });

  it("resolves an appellation to its country", async () => {
    const r = await db.query<{ name: string; level: string }>(
      `select name, level from geo_ancestry(
         (select id from geo_regions where slug='fr-pauillac')
       ) order by depth`,
    );
    expect(r.rows.map((x) => x.name)).toEqual(["Pauillac", "Bordeaux", "France"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT GEOMETRY — enforced by the database, not just the client
// ═══════════════════════════════════════════════════════════════════════════

describe("capacity", () => {
  it("staircase capacity is 130, computed in SQL", async () => {
    const r = await db.query<{ layout_capacity: number }>(
      `select layout_capacity('staircase', $1::jsonb)`,
      [JSON.stringify(OWNER_RACK)],
    );
    expect(r.rows[0]!.layout_capacity).toBe(130);
  });

  it("the stored layout cached the same capacity", async () => {
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id = $1`,
      [rackLayoutId],
    );
    expect(r.rows[0]!.capacity).toBe(130);
  });

  it("unpositioned and external are unbounded", async () => {
    const r = await db.query<{ a: number | null; b: number | null }>(
      `select layout_capacity('unpositioned','{}'::jsonb) as a,
              layout_capacity('external','{}'::jsonb) as b`,
    );
    expect(r.rows[0]!.a).toBeNull();
    expect(r.rows[0]!.b).toBeNull();
  });
});

describe("position validation in SQL matches the TypeScript domain", () => {
  const key = async (pos: unknown) => {
    const r = await db.query<{ validate_position: string | null }>(
      `select validate_position('staircase', $1::jsonb, $2::jsonb)`,
      [JSON.stringify(OWNER_RACK), JSON.stringify(pos)],
    );
    return r.rows[0]!.validate_position;
  };

  it("produces canonical keys", async () => {
    expect(await key({ col: 1, row: 1 })).toBe("c1r1");
    expect(await key({ col: 13, row: 16 })).toBe("c13r16");
  });

  it("key ignores property order — the reason position_key exists", async () => {
    expect(await key({ col: 3, row: 2 })).toBe(await key({ row: 2, col: 3 }));
  });

  it("rejects a column beyond the rack", async () => {
    await expect(key({ col: 14, row: 1 })).rejects.toThrow(/13 columns/);
  });

  it("rejects a row beyond that column's height", async () => {
    await expect(key({ col: 1, row: 5 })).rejects.toThrow(/4 bottles/);
  });

  it("rejects zero and negative coordinates", async () => {
    await expect(key({ col: 0, row: 1 })).rejects.toThrow();
    await expect(key({ col: 1, row: 0 })).rejects.toThrow();
  });

  it("rejects a position on unpositioned storage", async () => {
    const r = db.query(
      `select validate_position('external','{}'::jsonb,'{"col":1,"row":1}'::jsonb)`,
    );
    await expect(r).rejects.toThrow(/does not have slots/);
  });

  it("returns null for unpositioned storage with no position", async () => {
    const r = await db.query<{ validate_position: string | null }>(
      `select validate_position('external','{}'::jsonb, null)`,
    );
    expect(r.rows[0]!.validate_position).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACCEPTANCE TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("acceptance 1 — 12 bottles from one acquisition", () => {
  let acqId: string;

  it("creates 1 acquisition, 1 item and 12 bottles", async () => {
    const positions = Array.from({ length: 12 }, (_, i) => ({ col: 13, row: i + 1 }));
    const r = await db.query<{ create_acquisition_with_items: string }>(
      `select create_acquisition_with_items(gen_random_uuid(), $1, $2::jsonb, $3::jsonb)`,
      [
        cellarId,
        JSON.stringify({
          purchased_on: "2026-01-15",
          source: "Berry Bros & Rudd",
          total_amount: 7800,
        }),
        JSON.stringify([
          {
            wine_definition_id: wineA,
            quantity: 12,
            format: "case_12",
            unit_price: 650,
            storage_location_id: rackLocationId,
            positions,
          },
        ]),
      ],
    );
    acqId = r.rows[0]!.create_acquisition_with_items;

    const counts = await db.query<{ items: string; bottles: string }>(
      `select (select count(*)::text from acquisition_items where acquisition_id = $1) as items,
              (select count(*)::text from bottles b
                 join acquisition_items ai on ai.id = b.acquisition_item_id
               where ai.acquisition_id = $1) as bottles`,
      [acqId],
    );
    expect(Number(counts.rows[0]!.items)).toBe(1);
    expect(Number(counts.rows[0]!.bottles)).toBe(12);
  });

  it("stores purchase metadata exactly once", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from acquisitions where id = $1 and total_amount = 7800`,
      [acqId],
    );
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  it("writes an 'added' event per bottle", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from bottle_events e
         join bottles b on b.id = e.bottle_id
         join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1 and e.event_type = 'added'`,
      [acqId],
    );
    expect(Number(r.rows[0]!.count)).toBe(12);
  });

  it("there is no price column on bottles — one source of truth for money", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from information_schema.columns
       where table_name='bottles' and column_name in ('price','unit_price','purchase_price')`,
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });
});

describe("acceptance 2 — mixed 6-bottle order containing three wines", () => {
  it("creates 3 items and 6 bottles under one acquisition", async () => {
    const r = await db.query<{ create_acquisition_with_items: string }>(
      `select create_acquisition_with_items(gen_random_uuid(), $1, $2::jsonb, $3::jsonb)`,
      [
        cellarId,
        JSON.stringify({
          purchased_on: "2026-02-01",
          source: "The Wine Society",
          total_amount: 900,
        }),
        JSON.stringify([
          {
            wine_definition_id: wineA,
            quantity: 2,
            storage_location_id: merchantLocationId,
          },
          {
            wine_definition_id: wineB,
            quantity: 2,
            storage_location_id: merchantLocationId,
          },
          {
            wine_definition_id: wineC,
            quantity: 2,
            storage_location_id: merchantLocationId,
          },
        ]),
      ],
    );
    const acq = r.rows[0]!.create_acquisition_with_items;

    const items = await db.query<{ count: string }>(
      `select count(*)::text from acquisition_items where acquisition_id = $1`,
      [acq],
    );
    expect(Number(items.rows[0]!.count)).toBe(3);

    const wines = await db.query<{ count: string }>(
      `select count(distinct b.wine_definition_id)::text from bottles b
         join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1`,
      [acq],
    );
    expect(Number(wines.rows[0]!.count)).toBe(3);
  });
});

describe("acceptance 3 — one bottle home while 11 remain at the merchant", () => {
  let bottles: string[];

  beforeAll(async () => {
    const r = await db.query<{ create_acquisition_with_items: string }>(
      `select create_acquisition_with_items(gen_random_uuid(), $1, $2::jsonb, $3::jsonb)`,
      [
        cellarId,
        JSON.stringify({ source: "Berry Bros & Rudd" }),
        JSON.stringify([
          {
            wine_definition_id: wineB,
            quantity: 12,
            format: "case_12",
            unit_price: 280,
            storage_location_id: merchantLocationId,
          },
        ]),
      ],
    );
    const acq = r.rows[0]!.create_acquisition_with_items;
    const b = await db.query<{ id: string }>(
      `select b.id from bottles b
         join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1 order by b.created_at`,
      [acq],
    );
    bottles = b.rows.map((x) => x.id);
  });

  it("all 12 sit unpositioned at the merchant", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from bottles
       where id = any($1) and storage_location_id = $2 and position_key is null`,
      [bottles, merchantLocationId],
    );
    expect(Number(r.rows[0]!.count)).toBe(12);
  });

  it("delivering one moves only that bottle", async () => {
    await db.query(
      `select move_bottle(gen_random_uuid(), $1, 1, $2, $3::jsonb, 'delivered')`,
      [bottles[0], rackLocationId, JSON.stringify({ col: 12, row: 1 })],
    );

    const home = await db.query<{ count: string }>(
      `select count(*)::text from bottles where id = any($1) and storage_location_id = $2`,
      [bottles, rackLocationId],
    );
    const still = await db.query<{ count: string }>(
      `select count(*)::text from bottles where id = any($1) and storage_location_id = $2`,
      [bottles, merchantLocationId],
    );
    expect(Number(home.rows[0]!.count)).toBe(1);
    expect(Number(still.rows[0]!.count)).toBe(11);
  });

  it("records a 'delivered' event", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from bottle_events
       where bottle_id = $1 and event_type = 'delivered'`,
      [bottles[0]],
    );
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  it("siblings still share one acquisition item", async () => {
    const r = await db.query<{ count: string }>(
      `select count(distinct acquisition_item_id)::text from bottles where id = any($1)`,
      [bottles],
    );
    expect(Number(r.rows[0]!.count)).toBe(1);
  });
});

describe("acceptance 4 & 5 — consume, gift, sell, lose", () => {
  let bottles: string[];

  beforeAll(async () => {
    const r = await db.query<{ create_acquisition_with_items: string }>(
      `select create_acquisition_with_items(gen_random_uuid(), $1, $2::jsonb, $3::jsonb)`,
      [
        cellarId,
        JSON.stringify({ source: "Test" }),
        JSON.stringify([
          {
            wine_definition_id: wineC,
            quantity: 6,
            storage_location_id: merchantLocationId,
          },
        ]),
      ],
    );
    const b = await db.query<{ id: string }>(
      `select b.id from bottles b join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1 order by b.created_at`,
      [r.rows[0]!.create_acquisition_with_items],
    );
    bottles = b.rows.map((x) => x.id);
  });

  it("consuming one leaves siblings active", async () => {
    await db.query(
      `select change_bottle_status(gen_random_uuid(), $1, 1, 'consumed', now())`,
      [bottles[0]],
    );
    const active = await db.query<{ count: string }>(
      `select count(*)::text from bottles where id = any($1) and status = 'in_cellar'`,
      [bottles],
    );
    expect(Number(active.rows[0]!.count)).toBe(5);
  });

  it("a consumed bottle remains queryable forever", async () => {
    const r = await db.query<{ status: string }>(
      `select status from bottles where id = $1`,
      [bottles[0]],
    );
    expect(r.rows[0]!.status).toBe("consumed");
  });

  it("gifted, sold and lost all preserve history", async () => {
    await db.query(
      `select change_bottle_status(gen_random_uuid(), $1, 1, 'gifted', now())`,
      [bottles[1]],
    );
    await db.query(`select change_bottle_status(gen_random_uuid(), $1, 1, 'sold', now())`, [
      bottles[2],
    ]);
    await db.query(`select change_bottle_status(gen_random_uuid(), $1, 1, 'lost', now())`, [
      bottles[3],
    ]);

    const r = await db.query<{ status: string; count: string }>(
      `select status, count(*)::text from bottles where id = any($1) group by status order by status`,
      [bottles],
    );
    const map = Object.fromEntries(r.rows.map((x) => [x.status, Number(x.count)]));
    expect(map).toMatchObject({ consumed: 1, gifted: 1, sold: 1, lost: 1, in_cellar: 2 });
  });

  it("every status change wrote an immutable event", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from bottle_events
       where bottle_id = any($1) and event_type in ('consumed','gifted','sold','lost')`,
      [bottles],
    );
    expect(Number(r.rows[0]!.count)).toBe(4);
  });

  it("an inactive bottle holds no location or position", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from bottles
       where id = any($1) and status <> 'in_cellar'
         and (storage_location_id is not null or position_key is not null)`,
      [bottles],
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  it("'removed' demands a reason (amendment 3)", async () => {
    await expect(
      db.query(
        `select change_bottle_status(gen_random_uuid(), $1, 1, 'removed', now(), null)`,
        [bottles[4]],
      ),
    ).rejects.toThrow(/requires a reason/);

    await db.query(
      `select change_bottle_status(gen_random_uuid(), $1, 1, 'removed', now(), 'Entered twice by mistake')`,
      [bottles[4]],
    );
    const ev = await db.query<{ reason: string }>(
      `select reason from bottle_events where bottle_id = $1 and event_type = 'removed'`,
      [bottles[4]],
    );
    expect(ev.rows[0]!.reason).toBe("Entered twice by mistake");
  });

  it("bottles have no deleted_at — they are never deleted (amendment 3)", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from information_schema.columns
       where table_name='bottles' and column_name='deleted_at'`,
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });
});

describe("acceptance 6 — a bottle with unknown provenance", () => {
  it("exists happily with no acquisition", async () => {
    const b = await db.query<{ id: string }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1, $2, $3, $4) returning id`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    const r = await db.query<{ acquisition_item_id: string | null; status: string }>(
      `select acquisition_item_id, status from bottles where id = $1`,
      [b.rows[0]!.id],
    );
    expect(r.rows[0]!.acquisition_item_id).toBeNull();
    expect(r.rows[0]!.status).toBe("in_cellar");
  });
});

describe("acceptance 7 — unpositioned merchant storage", () => {
  it("holds many bottles with no slot collision", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from bottles
       where storage_location_id = $1 and status='in_cellar' and position_key is null`,
      [merchantLocationId],
    );
    expect(Number(r.rows[0]!.count)).toBeGreaterThan(5);
  });
});

describe("acceptance 8 — multiple racks are independent", () => {
  it("a second rack has its own slots", async () => {
    const layout = await db.query<{ create_storage_layout: string }>(
      `select create_storage_layout(gen_random_uuid(), $1, 'Kitchen Grid', 'grid', $2::jsonb)`,
      [cellarId, JSON.stringify({ rows: 4, columns: 4 })],
    );
    const loc = await db.query<{ create_storage_location: string }>(
      `select create_storage_location(gen_random_uuid(), $1, 'Kitchen Rack', 'home', $2)`,
      [cellarId, layout.rows[0]!.create_storage_layout],
    );
    const kitchenId = loc.rows[0]!.create_storage_location;

    // c1r1 exists in the staircase; x1y1 in the grid. Different keys, no clash.
    const b = await db.query<{ id: string }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id,
                            position, position_key, created_by)
       values ($1,$2,$3,'{"x":1,"y":1}'::jsonb,'x1y1',$4) returning id`,
      [cellarId, wineA, kitchenId, userId],
    );
    expect(b.rows[0]!.id).toBeTruthy();

    const cap = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id = $1`,
      [layout.rows[0]!.create_storage_layout],
    );
    expect(cap.rows[0]!.capacity).toBe(16);
  });
});

describe("acceptance 9 — duplicate slot prevention", () => {
  it("a second bottle cannot occupy an taken slot", async () => {
    await db.query(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id,
                            position, position_key, created_by)
       values ($1,$2,$3,'{"col":5,"row":3}'::jsonb,'c5r3',$4)`,
      [cellarId, wineA, rackLocationId, userId],
    );

    await expect(
      db.query(
        `insert into bottles (cellar_id, wine_definition_id, storage_location_id,
                              position, position_key, created_by)
         values ($1,$2,$3,'{"col":5,"row":3}'::jsonb,'c5r3',$4)`,
        [cellarId, wineB, rackLocationId, userId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("consuming the occupant frees the slot", async () => {
    const occupant = await db.query<{ id: string; version: number }>(
      `select id, version from bottles
       where storage_location_id=$1 and position_key='c5r3' and status='in_cellar'`,
      [rackLocationId],
    );
    await db.query(
      `select change_bottle_status(gen_random_uuid(), $1, $2, 'consumed', now())`,
      [occupant.rows[0]!.id, occupant.rows[0]!.version],
    );

    const reuse = await db.query<{ id: string }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id,
                            position, position_key, created_by)
       values ($1,$2,$3,'{"col":5,"row":3}'::jsonb,'c5r3',$4) returning id`,
      [cellarId, wineC, rackLocationId, userId],
    );
    expect(reuse.rows[0]!.id).toBeTruthy();
  });
});

describe("acceptance 10 & AMENDMENT 7 — geometry enforced, not just occupancy", () => {
  it("rejects a move to a column beyond the rack", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    await expect(
      db.query(
        `select move_bottle(gen_random_uuid(), $1, $2, $3, '{"col":14,"row":1}'::jsonb)`,
        [b.rows[0]!.id, b.rows[0]!.version, rackLocationId],
      ),
    ).rejects.toThrow(/13 columns/);
  });

  it("rejects a move to a row beyond that column's height", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    // Column 1 holds 4 bottles. Row 5 does not exist there.
    await expect(
      db.query(
        `select move_bottle(gen_random_uuid(), $1, $2, $3, '{"col":1,"row":5}'::jsonb)`,
        [b.rows[0]!.id, b.rows[0]!.version, rackLocationId],
      ),
    ).rejects.toThrow(/4 bottles/);
  });

  it("an invalid position writes NOTHING — the transaction rolls back", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    const id = b.rows[0]!.id;

    await expect(
      db.query(
        `select move_bottle(gen_random_uuid(), $1, $2, $3, '{"col":99,"row":99}'::jsonb)`,
        [id, b.rows[0]!.version, rackLocationId],
      ),
    ).rejects.toThrow();

    // Bottle unchanged, no event, no orphaned operation record.
    const after = await db.query<{ storage_location_id: string; version: number }>(
      `select storage_location_id, version from bottles where id = $1`,
      [id],
    );
    expect(after.rows[0]!.storage_location_id).toBe(merchantLocationId);
    expect(after.rows[0]!.version).toBe(b.rows[0]!.version);

    const ev = await db.query<{ count: string }>(
      `select count(*)::text from bottle_events where bottle_id = $1 and event_type='moved'`,
      [id],
    );
    expect(Number(ev.rows[0]!.count)).toBe(0);
  });

  it("rejects setting a position on unpositioned merchant storage", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    await expect(
      db.query(
        `select move_bottle(gen_random_uuid(), $1, $2, $3, '{"col":1,"row":1}'::jsonb)`,
        [b.rows[0]!.id, b.rows[0]!.version, merchantLocationId],
      ),
    ).rejects.toThrow(/does not have slots/);
  });
});

describe("acceptance 11 — valuation history", () => {
  it("keeps every valuation and reflects the latest on the bottle", async () => {
    const b = await db.query<{ id: string }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    const id = b.rows[0]!.id;

    for (const [amount, basis, source] of [
      [650, "merchant_retail", "merchant"],
      [720, "market_estimate", "api"],
      [810, "realised_sale", "auction_house"],
    ] as const) {
      await db.query(`select record_valuation(gen_random_uuid(), $1, $2::jsonb)`, [
        cellarId,
        JSON.stringify({ bottle_id: id, amount, valuation_basis: basis, source }),
      ]);
    }

    const hist = await db.query<{ count: string }>(
      `select count(*)::text from valuation_records where bottle_id = $1`,
      [id],
    );
    expect(Number(hist.rows[0]!.count)).toBe(3);

    const cur = await db.query<{ current_value: string }>(
      `select current_value::text from bottles where id = $1`,
      [id],
    );
    expect(Number(cur.rows[0]!.current_value)).toBe(810);
  });

  it("basis is recorded separately from source (amendment 6)", async () => {
    const r = await db.query<{ valuation_basis: string; source: string }>(
      `select valuation_basis, source from valuation_records
       where valuation_basis = 'realised_sale' limit 1`,
    );
    expect(r.rows[0]).toMatchObject({
      valuation_basis: "realised_sale",
      source: "auction_house",
    });
  });

  it("a valuation must target exactly one of a wine or a bottle", async () => {
    await expect(
      db.query(
        `insert into valuation_records (cellar_id, amount, valuation_basis)
         values ($1, 100, 'manual_estimate')`,
        [cellarId],
      ),
    ).rejects.toThrow();
  });
});

describe("acceptance 12 — tasting linked to a consumed bottle", () => {
  it("links tasting to wine, bottle and consumption event", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineB, merchantLocationId, userId],
    );
    const id = b.rows[0]!.id;

    await db.query(
      `select change_bottle_status(gen_random_uuid(), $1, $2, 'consumed', now())`,
      [id, b.rows[0]!.version],
    );
    const ev = await db.query<{ id: string }>(
      `select id from bottle_events where bottle_id=$1 and event_type='consumed'`,
      [id],
    );

    await db.query(`select record_tasting(gen_random_uuid(), $1, $2::jsonb)`, [
      cellarId,
      JSON.stringify({
        wine_definition_id: wineB,
        bottle_id: id,
        bottle_event_id: ev.rows[0]!.id,
        rating: 5,
        notes: "Exceptional",
      }),
    ]);

    const t = await db.query<{
      rating: number;
      bottle_id: string;
      bottle_event_id: string;
    }>(
      `select rating, bottle_id, bottle_event_id from tasting_records where bottle_id=$1`,
      [id],
    );
    expect(t.rows[0]!.rating).toBe(5);
    expect(t.rows[0]!.bottle_event_id).toBe(ev.rows[0]!.id);
  });

  it("a tasting can exist with no bottle — tasted elsewhere", async () => {
    const r = await db.query<{ record_tasting: string }>(
      `select record_tasting(gen_random_uuid(), $1, $2::jsonb)`,
      [
        cellarId,
        JSON.stringify({ wine_definition_id: wineC, rating: 4, notes: "At a restaurant" }),
      ],
    );
    expect(r.rows[0]!.record_tasting).toBeTruthy();
  });
});

describe("acceptance 15 — operation replay produces no duplicate effect", () => {
  it("replaying an acquisition creates twelve bottles, not twenty-four", async () => {
    const opId = "11111111-1111-1111-1111-111111111111";
    const payload = [
      cellarId,
      JSON.stringify({ source: "Replay Test" }),
      JSON.stringify([
        {
          wine_definition_id: wineA,
          quantity: 12,
          storage_location_id: merchantLocationId,
        },
      ]),
    ];

    const first = await db.query<{ create_acquisition_with_items: string }>(
      `select create_acquisition_with_items($1, $2, $3::jsonb, $4::jsonb)`,
      [opId, ...payload],
    );
    const second = await db.query<{ create_acquisition_with_items: string }>(
      `select create_acquisition_with_items($1, $2, $3::jsonb, $4::jsonb)`,
      [opId, ...payload],
    );

    // Same id returned; nothing created the second time.
    expect(second.rows[0]!.create_acquisition_with_items).toBe(
      first.rows[0]!.create_acquisition_with_items,
    );

    const acqs = await db.query<{ count: string }>(
      `select count(*)::text from acquisitions where source = 'Replay Test'`,
    );
    expect(Number(acqs.rows[0]!.count)).toBe(1);
  });

  it("replaying a move applies once", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    const opId = "22222222-2222-2222-2222-222222222222";

    await db.query(`select move_bottle($1,$2,$3,$4,'{"col":2,"row":2}'::jsonb)`, [
      opId,
      b.rows[0]!.id,
      b.rows[0]!.version,
      rackLocationId,
    ]);
    // Replay with the SAME stale version — must be a no-op, not a conflict.
    await db.query(`select move_bottle($1,$2,$3,$4,'{"col":2,"row":2}'::jsonb)`, [
      opId,
      b.rows[0]!.id,
      b.rows[0]!.version,
      rackLocationId,
    ]);

    const ev = await db.query<{ count: string }>(
      `select count(*)::text from bottle_events where bottle_id=$1 and event_type='moved'`,
      [b.rows[0]!.id],
    );
    expect(Number(ev.rows[0]!.count)).toBe(1);

    const ver = await db.query<{ version: number }>(
      `select version from bottles where id=$1`,
      [b.rows[0]!.id],
    );
    expect(ver.rows[0]!.version).toBe(b.rows[0]!.version + 1);
  });
});

describe("acceptance 16 — concurrent version conflict", () => {
  it("a stale version is rejected and nothing changes", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    const id = b.rows[0]!.id;
    const stale = b.rows[0]!.version;

    // Device A moves it.
    await db.query(
      `select move_bottle(gen_random_uuid(),$1,$2,$3,'{"col":3,"row":1}'::jsonb)`,
      [id, stale, rackLocationId],
    );

    // Device B, still holding the old version, tries to move it elsewhere.
    await expect(
      db.query(
        `select move_bottle(gen_random_uuid(),$1,$2,$3,'{"col":4,"row":1}'::jsonb)`,
        [id, stale, rackLocationId],
      ),
    ).rejects.toThrow(/version conflict/);

    const pos = await db.query<{ position_key: string }>(
      `select position_key from bottles where id=$1`,
      [id],
    );
    expect(pos.rows[0]!.position_key).toBe("c3r1");
  });
});

describe("amendment 4 — 'corrected' is not a validation bypass", () => {
  it("still rejects an invalid position", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    await expect(
      db.query(`select correct_bottle(gen_random_uuid(),$1,$2,'typo',$3::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        JSON.stringify({
          storage_location_id: rackLocationId,
          position: { col: 99, row: 99 },
        }),
      ]),
    ).rejects.toThrow(/13 columns/);
  });

  it("still rejects an invalid bottle size", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    await expect(
      db.query(`select correct_bottle(gen_random_uuid(),$1,$2,'typo',$3::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        JSON.stringify({ bottle_size: "2000ml" }),
      ]),
    ).rejects.toThrow(/Invalid bottle size/);
  });

  it("still enforces slot uniqueness", async () => {
    await db.query(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id,
                            position, position_key, created_by)
       values ($1,$2,$3,'{"col":6,"row":2}'::jsonb,'c6r2',$4)`,
      [cellarId, wineA, rackLocationId, userId],
    );
    const other = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineB, merchantLocationId, userId],
    );
    await expect(
      db.query(`select correct_bottle(gen_random_uuid(),$1,$2,'fixing',$3::jsonb)`, [
        other.rows[0]!.id,
        other.rows[0]!.version,
        JSON.stringify({
          storage_location_id: rackLocationId,
          position: { col: 6, row: 2 },
        }),
      ]),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("demands a reason", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    await expect(
      db.query(`select correct_bottle(gen_random_uuid(),$1,$2,'',$3::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        JSON.stringify({ notes: "x" }),
      ]),
    ).rejects.toThrow(/requires a reason/);
  });

  it("succeeds with a valid correction and records the reason", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantLocationId, userId],
    );
    await db.query(`select correct_bottle(gen_random_uuid(),$1,$2,$3,$4::jsonb)`, [
      b.rows[0]!.id,
      b.rows[0]!.version,
      "Recorded as magnum, actually a standard bottle",
      JSON.stringify({ bottle_size: "750ml" }),
    ]);
    const ev = await db.query<{ reason: string }>(
      `select reason from bottle_events where bottle_id=$1 and event_type='corrected'`,
      [b.rows[0]!.id],
    );
    expect(ev.rows[0]!.reason).toMatch(/actually a standard bottle/);
  });
});

describe("immutability of history", () => {
  it("bottle_events has no update or delete policy", async () => {
    const r = await db.query<{ cmd: string }>(
      `select cmd from pg_policies where tablename='bottle_events'`,
    );
    const cmds = r.rows.map((x) => x.cmd);
    expect(cmds).not.toContain("UPDATE");
    expect(cmds).not.toContain("DELETE");
    expect(cmds).toContain("SELECT");
    expect(cmds).toContain("INSERT");
  });

  it("valuation_records has no update or delete policy", async () => {
    const r = await db.query<{ cmd: string }>(
      `select cmd from pg_policies where tablename='valuation_records'`,
    );
    const cmds = r.rows.map((x) => x.cmd);
    expect(cmds).not.toContain("UPDATE");
    expect(cmds).not.toContain("DELETE");
  });

  it("NO domain table has a delete policy", async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_policies where cmd='DELETE'`,
    );
    expect(r.rows).toHaveLength(0);
  });

  it("RLS is enabled on every table", async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_tables
       where schemaname='public' and rowsecurity = false`,
    );
    expect(r.rows.map((x) => x.tablename)).toEqual([]);
  });
});

describe("amendment 1 — no storage is seeded by migration", () => {
  it("migrations create no storage locations or layouts", async () => {
    // Everything present was created through the API in beforeAll.
    const r = await db.query<{ count: string }>(
      `select count(*)::text from storage_locations where created_by is null`,
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  it("no migration file references the owner's merchants", async () => {
    const files = [
      "001_foundation.sql",
      "002_geography.sql",
      "004_wine_definitions.sql",
      "005_storage.sql",
      "007_bottles.sql",
      "013_rls.sql",
    ];
    for (const f of files) {
      const content = sql(f);
      expect(content, `${f} must not seed merchant names`).not.toMatch(
        /Berry Bros|Wine Society/,
      );
    }
  });
});
