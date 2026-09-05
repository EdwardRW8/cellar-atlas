// @vitest-environment node

/**
 * DEVELOPMENT FIXTURE — verification
 *
 * The fixture uses the same RPC functions the application uses, so running it
 * exercises the real mutation path: idempotency, geometry validation, event
 * logging, the lot. If the fixture works, those paths work.
 *
 * A thin Supabase-shaped adapter over PGlite lets the fixture run unmodified.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  seedFixture,
  seedAlternativeLayoutFixture,
  isSafeToSeed,
  STAIRCASE_RACK,
  GRID_RACK,
  WINE_FRIDGE,
  FIXTURE_MARKER,
} from "@/data/fixtures/dev-fixture";
import { capacity } from "@/domain/storage/layout";

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
];

let db: PGlite;
let cellarId: string;
let userId: string;

/** Minimal Supabase-client shape, backed by PGlite. */
function adapter(pg: PGlite) {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const placeholders = keys.map((k, i) => {
        const v = args[k];
        const cast = v !== null && typeof v === "object" ? "::jsonb" : "";
        return `${k} => $${i + 1}${cast}`;
      });
      const values = keys.map((k) => {
        const v = args[k];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      try {
        const r = await pg.query<Record<string, unknown>>(
          `select ${fn}(${placeholders.join(", ")}) as result`,
          values,
        );
        return { data: r.rows[0]?.result ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    from(table: string) {
      const state = {
        cols: "*",
        filters: [] as string[],
        params: [] as unknown[],
        limit: "",
      };
      const api = {
        select(cols: string, _o?: unknown) {
          state.cols = cols === "*" ? "*" : cols;
          return api;
        },
        eq(c: string, v: unknown) {
          state.params.push(v);
          state.filters.push(`${c} = $${state.params.length}`);
          return api;
        },
        is(c: string, v: null) {
          state.filters.push(`${c} is ${v === null ? "null" : v}`);
          return api;
        },
        in(c: string, vs: unknown[]) {
          state.params.push(vs);
          state.filters.push(`${c} = any($${state.params.length})`);
          return api;
        },
        like(c: string, v: string) {
          state.params.push(v);
          state.filters.push(`${c} like $${state.params.length}`);
          return api;
        },
        limit(n: number) {
          state.limit = ` limit ${n}`;
          return api;
        },
        then(resolve: (r: { data: unknown[]; error: null; count?: number }) => void) {
          const where = state.filters.length ? ` where ${state.filters.join(" and ")}` : "";
          pg.query(`select ${state.cols} from ${table}${where}${state.limit}`, state.params)
            .then((r) => resolve({ data: r.rows, error: null, count: r.rows.length }))
            .catch(() => resolve({ data: [], error: null, count: 0 }));
        },
      };
      return api;
    },
  } as never;
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
    `insert into auth.users (email) values ('dev@test') returning id`,
  );
  userId = u.rows[0]!.id;
  await db.exec(`set test.user_id = '${userId}'`);

  for (const f of MIGRATIONS) await db.exec(sql(f));

  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Dev Cellar', $1) returning id`,
    [userId],
  );
  cellarId = c.rows[0]!.id;
}, 60_000);

describe("fixture safety", () => {
  it("an empty cellar is safe to seed", async () => {
    const r = await isSafeToSeed(adapter(db), cellarId);
    expect(r.safe).toBe(true);
  });

  it("refuses a cellar containing non-fixture wines", async () => {
    const other = await db.query<{ id: string }>(
      `insert into cellars (name, created_by) values ('Real Cellar', $1) returning id`,
      [userId],
    );
    await db.query(
      `insert into wine_definitions (cellar_id, producer, name, notes)
       values ($1, 'Real Producer', 'Real Wine', 'my actual note')`,
      [other.rows[0]!.id],
    );

    const r = await isSafeToSeed(adapter(db), other.rows[0]!.id);
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/Refusing to seed/);
  });

  it("does not run automatically — it must be called", async () => {
    // No import side effect creates data.
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from storage_locations where cellar_id = $1`,
      [cellarId],
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });
});

describe("fixture creates the expected cellar", () => {
  let result: Awaited<ReturnType<typeof seedFixture>>;

  beforeAll(async () => {
    result = await seedFixture(adapter(db), cellarId);
  }, 60_000);

  it("reports no warnings — every geography slug resolved", () => {
    expect(result.warnings).toEqual([]);
  });

  it("creates Home Cellar with the staircase rack", async () => {
    const r = await db.query<{ name: string; type: string; capacity: number }>(
      `select sl.name, l.type, l.capacity
       from storage_locations sl join storage_layouts l on l.id = sl.storage_layout_id
       where sl.id = $1`,
      [result.locations.home],
    );
    expect(r.rows[0]).toMatchObject({
      name: "Home Cellar",
      type: "staircase",
      capacity: 130,
    });
  });

  it("the rack is 13 columns, heights 4→16, capacity 130", async () => {
    const r = await db.query<{ config: Record<string, unknown> }>(
      `select config from storage_layouts where id = $1`,
      [result.layouts.rack],
    );
    const cfg = r.rows[0]!.config as typeof STAIRCASE_RACK;
    expect(cfg.columns).toBe(13);
    expect(cfg.heights).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(cfg.chamfer).toBe(true);
    expect(cfg.orientation).toBe("ascending-right");
    expect(capacity("staircase", cfg)).toBe(130);
  });

  it("creates both external merchants", async () => {
    const r = await db.query<{ name: string; is_external: boolean }>(
      `select name, is_external from storage_locations
       where cellar_id = $1 and is_external = true order by name`,
      [cellarId],
    );
    expect(r.rows.map((x) => x.name)).toEqual(["Berry Bros & Rudd", "The Wine Society"]);
    expect(r.rows.every((x) => x.is_external)).toBe(true);
  });

  it("merchant storage has no layout — it has no slots", async () => {
    const r = await db.query<{ storage_layout_id: string | null }>(
      `select storage_layout_id from storage_locations
       where cellar_id = $1 and is_external = true`,
      [cellarId],
    );
    expect(r.rows.every((x) => x.storage_layout_id === null)).toBe(true);
  });

  it("creates 16 clearly synthetic wines", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from wine_definitions
       where cellar_id = $1 and notes like $2`,
      [cellarId, `%${FIXTURE_MARKER}%`],
    );
    expect(Number(r.rows[0]!.c)).toBe(16);
  });

  it("covers multiple colours, countries and vintages", async () => {
    const colours = await db.query<{ c: string }>(
      `select count(distinct colour)::text c from wine_definitions where cellar_id=$1`,
      [cellarId],
    );
    const countries = await db.query<{ c: string }>(
      `select count(distinct country_code)::text c from wine_definitions where cellar_id=$1`,
      [cellarId],
    );
    const vintages = await db.query<{ c: string }>(
      `select count(distinct vintage)::text c from wine_definitions where cellar_id=$1`,
      [cellarId],
    );
    expect(Number(colours.rows[0]!.c)).toBeGreaterThanOrEqual(3);
    expect(Number(countries.rows[0]!.c)).toBeGreaterThanOrEqual(7);
    expect(Number(vintages.rows[0]!.c)).toBeGreaterThanOrEqual(8);
  });

  it("every wine resolves to a canonical geography node", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from wine_definitions
       where cellar_id=$1 and geo_region_id is null`,
      [cellarId],
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("covers the full range of drinking-window states", async () => {
    const r = await db.query<{ drink_from: number; drink_until: number }>(
      `select drink_from, drink_until from wine_definitions where cellar_id=$1`,
      [cellarId],
    );
    const now = new Date().getFullYear();
    expect(r.rows.some((w) => w.drink_until < now)).toBe(true); // past
    expect(r.rows.some((w) => w.drink_from > now + 3)).toBe(true); // very young
    expect(r.rows.some((w) => w.drink_from <= now && w.drink_until >= now)).toBe(true); // ready
  });

  it("places bottles in the rack and at both merchants", async () => {
    const r = await db.query<{ name: string; c: string }>(
      `select sl.name, count(*)::text c
       from bottles b join storage_locations sl on sl.id = b.storage_location_id
       where b.cellar_id = $1 and b.status = 'in_cellar'
       group by sl.name order by sl.name`,
      [cellarId],
    );
    const byName = Object.fromEntries(r.rows.map((x) => [x.name, Number(x.c)]));
    expect(byName["Home Cellar"]).toBeGreaterThan(10);
    expect(byName["Berry Bros & Rudd"]).toBe(6);
    expect(byName["The Wine Society"]).toBe(6);
  });

  it("rack bottles all have valid positions, merchant bottles have none", async () => {
    const positioned = await db.query<{ c: string }>(
      `select count(*)::text c from bottles
       where storage_location_id=$1 and status='in_cellar' and position_key is null`,
      [result.locations.home],
    );
    expect(Number(positioned.rows[0]!.c)).toBe(0);

    const unpositioned = await db.query<{ c: string }>(
      `select count(*)::text c from bottles
       where storage_location_id=$1 and position_key is not null`,
      [result.locations.berryBros],
    );
    expect(Number(unpositioned.rows[0]!.c)).toBe(0);
  });

  it("no two bottles share a rack slot", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from (
         select position_key from bottles
         where storage_location_id=$1 and status='in_cellar' and position_key is not null
         group by position_key having count(*) > 1
       ) dupes`,
      [result.locations.home],
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("creates consumption history and tastings", async () => {
    const consumed = await db.query<{ c: string }>(
      `select count(*)::text c from bottles where cellar_id=$1 and status='consumed'`,
      [cellarId],
    );
    const tastings = await db.query<{ c: string }>(
      `select count(*)::text c from tasting_records where cellar_id=$1`,
      [cellarId],
    );
    expect(Number(consumed.rows[0]!.c)).toBe(2);
    expect(Number(tastings.rows[0]!.c)).toBe(2);
  });

  it("creates a valuation so purchase price and current value differ", async () => {
    const r = await db.query<{ amount: string; valuation_basis: string }>(
      `select amount::text, valuation_basis from valuation_records where cellar_id=$1`,
      [cellarId],
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0]!.valuation_basis).toBe("market_estimate");
  });

  it("every bottle has a full event trail", async () => {
    const bottles = await db.query<{ c: string }>(
      `select count(*)::text c from bottles where cellar_id=$1`,
      [cellarId],
    );
    const withEvents = await db.query<{ c: string }>(
      `select count(distinct bottle_id)::text c from bottle_events where cellar_id=$1`,
      [cellarId],
    );
    expect(Number(withEvents.rows[0]!.c)).toBe(Number(bottles.rows[0]!.c));
  });

  it("every event is traceable to the operation that caused it", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from bottle_events
       where cellar_id=$1 and source_operation_id is null`,
      [cellarId],
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("the 12-bottle case shares one source operation", async () => {
    const r = await db.query<{ c: string; ops: string }>(
      `select count(*)::text c, count(distinct e.source_operation_id)::text ops
       from bottle_events e
         join bottles b on b.id = e.bottle_id
         join acquisition_items ai on ai.id = b.acquisition_item_id
         join acquisitions a on a.id = ai.acquisition_id
       where a.reference = 'DEV-CASE-12' and e.event_type = 'added'`,
    );
    expect(Number(r.rows[0]!.c)).toBe(12);
    expect(Number(r.rows[0]!.ops)).toBe(1);
  });

  it("the mixed order created three lines and six bottles", async () => {
    const r = await db.query<{ items: string; bottles: string }>(
      `select (select count(*)::text from acquisition_items ai
                 join acquisitions a on a.id=ai.acquisition_id
               where a.reference='DEV-MIXED-6') as items,
              (select count(*)::text from bottles b
                 join acquisition_items ai on ai.id=b.acquisition_item_id
                 join acquisitions a on a.id=ai.acquisition_id
               where a.reference='DEV-MIXED-6') as bottles`,
    );
    expect(Number(r.rows[0]!.items)).toBe(3);
    expect(Number(r.rows[0]!.bottles)).toBe(6);
  });

  it("refuses to seed twice, cleanly", async () => {
    await expect(seedFixture(adapter(db), cellarId)).rejects.toThrow(
      /Refusing to seed twice/,
    );
  });

  it("reports why, rather than failing on a constraint later", async () => {
    const r = await isSafeToSeed(adapter(db), cellarId);
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/reset-fixture/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ALTERNATIVE LAYOUT — proving no global staircase assumption
// ═══════════════════════════════════════════════════════════════════════════

describe("a second cellar with a completely different storage setup", () => {
  let altCellar: string;
  let alt: Awaited<ReturnType<typeof seedAlternativeLayoutFixture>>;

  beforeAll(async () => {
    const c = await db.query<{ id: string }>(
      `insert into cellars (name, created_by) values ('Alt Cellar', $1) returning id`,
      [userId],
    );
    altCellar = c.rows[0]!.id;
    alt = await seedAlternativeLayoutFixture(adapter(db), altCellar);
  }, 60_000);

  it("has NO staircase layout at all", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from storage_layouts
       where cellar_id=$1 and type='staircase'`,
      [altCellar],
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("uses a grid whose capacity is derived: 96", async () => {
    const r = await db.query<{ capacity: number; type: string }>(
      `select capacity, type from storage_layouts where id=$1`,
      [alt.layouts.grid],
    );
    expect(r.rows[0]!.type).toBe("grid");
    expect(r.rows[0]!.capacity).toBe(GRID_RACK.rows * GRID_RACK.columns);
    expect(r.rows[0]!.capacity).not.toBe(130);
  });

  it("uses a fridge whose capacity is derived from its zones: 62", async () => {
    const expected = WINE_FRIDGE.zones.reduce((a, z) => a + z.shelves * z.perShelf, 0);
    const r = await db.query<{ capacity: number }>(
      `select capacity from storage_layouts where id=$1`,
      [alt.layouts.fridge],
    );
    expect(r.rows[0]!.capacity).toBe(expected);
  });

  it("stores grid positions as {x,y}, not {col,row}", async () => {
    const r = await db.query<{ position_key: string; position: Record<string, unknown> }>(
      `select position_key, position from bottles
       where storage_location_id=$1 and status='in_cellar' limit 1`,
      [alt.locations.wall],
    );
    expect(r.rows[0]!.position_key).toMatch(/^x\d+y\d+$/);
    expect(Object.keys(r.rows[0]!.position)).toEqual(expect.arrayContaining(["x", "y"]));
  });

  it("stores fridge positions as {zone,shelf,index}", async () => {
    const r = await db.query<{ position_key: string }>(
      `select position_key from bottles
       where storage_location_id=$1 and status='in_cellar' limit 1`,
      [alt.locations.fridge],
    );
    expect(r.rows[0]!.position_key).toMatch(/^z\d+s\d+i\d+$/);
  });

  it("holds 12 unpositioned bottles at its own merchant", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from bottles
       where storage_location_id=$1 and position_key is null`,
      [alt.locations.merchant],
    );
    expect(Number(r.rows[0]!.c)).toBe(12);
  });

  it("names a merchant of its own, not the owner's", async () => {
    const r = await db.query<{ name: string }>(
      `select name from storage_locations where cellar_id=$1 and is_external=true`,
      [altCellar],
    );
    expect(r.rows.map((x) => x.name)).toEqual(["Independent Merchant"]);
    expect(r.rows.map((x) => x.name)).not.toContain("Berry Bros & Rudd");
  });

  it("the two cellars coexist with entirely different storage", async () => {
    const r = await db.query<{ cellar_id: string; types: string }>(
      `select cellar_id, string_agg(distinct type, ',' order by type) as types
       from storage_layouts group by cellar_id order by cellar_id`,
    );
    const sets = r.rows.map((x) => x.types);
    expect(sets).toContain("staircase");
    expect(sets).toContain("fridge,grid");
  });

  it("rejects a staircase position in the grid cellar", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, version`,
      [altCellar, alt.wineIds[0], userId],
    );
    await expect(
      db.query(`select move_bottle(gen_random_uuid(),$1,$2,$3,$4::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        alt.locations.wall,
        JSON.stringify({ col: 1, row: 1 }),
      ]),
    ).rejects.toThrow(/x must be a positive integer/);
  });

  it("rejects a position beyond the grid's own bounds", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, version`,
      [altCellar, alt.wineIds[0], userId],
    );
    await expect(
      db.query(`select move_bottle(gen_random_uuid(),$1,$2,$3,$4::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        alt.locations.wall,
        JSON.stringify({ x: 13, y: 1 }),
      ]),
    ).rejects.toThrow(/exceeds 12 columns/);
  });

  it("rejects an occupied grid position", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, version`,
      [altCellar, alt.wineIds[0], userId],
    );
    await expect(
      db.query(`select move_bottle(gen_random_uuid(),$1,$2,$3,$4::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        alt.locations.wall,
        JSON.stringify({ x: 1, y: 1 }),
      ]), // seeded above
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
