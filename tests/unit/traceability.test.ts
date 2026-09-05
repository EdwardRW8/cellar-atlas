// @vitest-environment node

/**
 * PHASE 2.1 — OPERATION TRACEABILITY
 *
 * Before this change, `bottle_events.operation_id` was UNIQUE. That forced
 * `create_acquisition_with_items` to write NULL for all twelve 'added'
 * events, because one operation legitimately produces many events. The audit
 * trail lost the very link it existed to provide.
 *
 * The model is now:
 *   applied_operations.operation_id   PRIMARY KEY  — idempotency
 *   bottle_events.id                  PRIMARY KEY  — event identity
 *   bottle_events.source_operation_id NOT UNIQUE   — causal link
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
];

let db: PGlite;
let cellarId: string;
let userId: string;
let rackLocationId: string;
let merchantId: string;
let wineA: string;

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
    `insert into auth.users (email) values ('owner@test') returning id`,
  );
  userId = u.rows[0]!.id;
  await db.exec(`set test.user_id = '${userId}'`);

  for (const f of MIGRATIONS) await db.exec(sql(f));

  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Trace', '${userId}') returning id`,
  );
  cellarId = c.rows[0]!.id;

  const layout = await db.query<{ create_storage_layout: string }>(
    `select create_storage_layout(gen_random_uuid(), $1, 'Rack', 'staircase', $2::jsonb)`,
    [
      cellarId,
      JSON.stringify({
        columns: 13,
        heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
        chamfer: true,
        orientation: "ascending-right",
      }),
    ],
  );

  const loc = await db.query<{ create_storage_location: string }>(
    `select create_storage_location(gen_random_uuid(), $1, 'Home', 'home', $2)`,
    [cellarId, layout.rows[0]!.create_storage_layout],
  );
  rackLocationId = loc.rows[0]!.create_storage_location;

  const m = await db.query<{ create_storage_location: string }>(
    `select create_storage_location(gen_random_uuid(), $1, 'Merchant', 'merchant', null, true)`,
    [cellarId],
  );
  merchantId = m.rows[0]!.create_storage_location;

  const w = await db.query<{ create_wine_definition: string }>(
    `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
    [cellarId, JSON.stringify({ producer: "Test", name: "Wine A", vintage: 2018 })],
  );
  wineA = w.rows[0]!.create_wine_definition;
}, 60_000);

describe("schema shape", () => {
  it("source_operation_id exists and the old column is gone", async () => {
    const r = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name='bottle_events' and column_name in ('operation_id','source_operation_id')`,
    );
    const cols = r.rows.map((x) => x.column_name);
    expect(cols).toContain("source_operation_id");
    expect(cols).not.toContain("operation_id");
  });

  it("source_operation_id is NOT unique — one operation may cause many events", async () => {
    const r = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where tablename='bottle_events' and indexdef ilike '%source_operation_id%'`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.indexdef).not.toMatch(/CREATE UNIQUE/i);
    }
  });

  it("applied_operations.operation_id remains the unique idempotency key", async () => {
    const r = await db.query<{ constraint_type: string }>(
      `select tc.constraint_type from information_schema.table_constraints tc
         join information_schema.key_column_usage k
           on k.constraint_name = tc.constraint_name
       where tc.table_name='applied_operations' and k.column_name='operation_id'`,
    );
    expect(r.rows.map((x) => x.constraint_type)).toContain("PRIMARY KEY");
  });

  it("bottle_events.id remains the unique event identity", async () => {
    const r = await db.query<{ constraint_type: string }>(
      `select tc.constraint_type from information_schema.table_constraints tc
         join information_schema.key_column_usage k
           on k.constraint_name = tc.constraint_name
       where tc.table_name='bottle_events' and k.column_name='id'`,
    );
    expect(r.rows.map((x) => x.constraint_type)).toContain("PRIMARY KEY");
  });
});

describe("12-bottle acquisition → 12 events sharing one source operation", () => {
  const OP = "aaaaaaaa-0000-4000-8000-000000000001";
  let acqId: string;

  beforeAll(async () => {
    const positions = Array.from({ length: 12 }, (_, i) => ({ col: 13, row: i + 1 }));
    const r = await db.query<{ create_acquisition_with_items: string }>(
      `select create_acquisition_with_items($1, $2, $3::jsonb, $4::jsonb, $5)`,
      [
        OP,
        cellarId,
        JSON.stringify({
          purchased_on: "2026-03-01",
          source: "Test Merchant",
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
        "dev-trace",
      ],
    );
    acqId = r.rows[0]!.create_acquisition_with_items;
  });

  it("creates exactly 12 bottles", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from bottles b
         join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1`,
      [acqId],
    );
    expect(Number(r.rows[0]!.count)).toBe(12);
  });

  it("creates exactly 12 'added' events", async () => {
    const r = await db.query<{ count: string }>(
      `select count(*)::text from bottle_events
       where source_operation_id = $1 and event_type = 'added'`,
      [OP],
    );
    expect(Number(r.rows[0]!.count)).toBe(12);
  });

  it("ALL 12 events share the one source operation — none are null", async () => {
    const r = await db.query<{ total: string; linked: string; distinct_ops: string }>(
      `select count(*)::text as total,
              count(source_operation_id)::text as linked,
              count(distinct source_operation_id)::text as distinct_ops
       from bottle_events e
         join bottles b on b.id = e.bottle_id
         join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1`,
      [acqId],
    );
    expect(Number(r.rows[0]!.total)).toBe(12);
    expect(Number(r.rows[0]!.linked)).toBe(12); // ← was 0 before the fix
    expect(Number(r.rows[0]!.distinct_ops)).toBe(1);
  });

  it("each event keeps its own unique identity", async () => {
    const r = await db.query<{ count: string }>(
      `select count(distinct id)::text from bottle_events where source_operation_id = $1`,
      [OP],
    );
    expect(Number(r.rows[0]!.count)).toBe(12);
  });

  it("the operation is traceable back to applied_operations", async () => {
    const r = await db.query<{ entity: string; operation: string; device_id: string }>(
      `select entity, operation, device_id from applied_operations where operation_id = $1`,
      [OP],
    );
    expect(r.rows[0]).toMatchObject({ entity: "acquisition", operation: "create" });
    expect(r.rows[0]!.device_id).toBe("dev-trace");
  });

  it("a full audit trail can be reconstructed from one operation id", async () => {
    const r = await db.query<{ event_type: string; bottle_id: string }>(
      `select e.event_type, e.bottle_id
       from bottle_events e
       where e.source_operation_id = $1
       order by e.created_at`,
      [OP],
    );
    expect(r.rows).toHaveLength(12);
    expect(new Set(r.rows.map((x) => x.bottle_id)).size).toBe(12);
    expect(new Set(r.rows.map((x) => x.event_type))).toEqual(new Set(["added"]));
  });
});

describe("replay creates no additional events", () => {
  const OP = "aaaaaaaa-0000-4000-8000-000000000002";

  it("replaying a 12-bottle acquisition leaves 12 events, not 24", async () => {
    const payload: [string, string, string, string] = [
      OP,
      cellarId,
      JSON.stringify({ source: "Replay Merchant" }),
      JSON.stringify([
        { wine_definition_id: wineA, quantity: 12, storage_location_id: merchantId },
      ]),
    ];

    const first = await db.query<{ create_acquisition_with_items: string }>(
      `select create_acquisition_with_items($1,$2,$3::jsonb,$4::jsonb)`,
      payload,
    );
    const after1 = await db.query<{ count: string }>(
      `select count(*)::text from bottle_events where source_operation_id = $1`,
      [OP],
    );

    const second = await db.query<{ create_acquisition_with_items: string }>(
      `select create_acquisition_with_items($1,$2,$3::jsonb,$4::jsonb)`,
      payload,
    );
    const after2 = await db.query<{ count: string }>(
      `select count(*)::text from bottle_events where source_operation_id = $1`,
      [OP],
    );

    expect(Number(after1.rows[0]!.count)).toBe(12);
    expect(Number(after2.rows[0]!.count)).toBe(12); // unchanged
    // And the replay returns the ORIGINAL acquisition id.
    expect(second.rows[0]!.create_acquisition_with_items).toBe(
      first.rows[0]!.create_acquisition_with_items,
    );

    const bottles = await db.query<{ count: string }>(
      `select count(*)::text from bottles b
         join acquisition_items ai on ai.id = b.acquisition_item_id
         join acquisitions a on a.id = ai.acquisition_id
       where a.source = 'Replay Merchant'`,
    );
    expect(Number(bottles.rows[0]!.count)).toBe(12);
  });
});

describe("single-bottle mutations link correctly", () => {
  let bottleId: string;
  let version: number;

  beforeAll(async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantId, userId],
    );
    bottleId = b.rows[0]!.id;
    version = b.rows[0]!.version;
  });

  it("move_bottle links its event to the operation", async () => {
    const OP = "bbbbbbbb-0000-4000-8000-000000000001";
    await db.query(`select move_bottle($1,$2,$3,$4,$5::jsonb,'moved',null,'dev-x')`, [
      OP,
      bottleId,
      version,
      rackLocationId,
      JSON.stringify({ col: 8, row: 2 }),
    ]);

    const r = await db.query<{ count: string; op: string }>(
      `select count(*)::text, max(source_operation_id::text) as op
       from bottle_events where bottle_id=$1 and event_type='moved'`,
      [bottleId],
    );
    expect(Number(r.rows[0]!.count)).toBe(1);
    expect(r.rows[0]!.op).toBe(OP);
    version += 1;
  });

  it("change_bottle_status links its event", async () => {
    const OP = "bbbbbbbb-0000-4000-8000-000000000002";
    await db.query(`select change_bottle_status($1,$2,$3,'consumed',now())`, [
      OP,
      bottleId,
      version,
    ]);

    const r = await db.query<{ op: string }>(
      `select source_operation_id::text as op from bottle_events
       where bottle_id=$1 and event_type='consumed'`,
      [bottleId],
    );
    expect(r.rows[0]!.op).toBe(OP);
    version += 1;
  });

  it("record_tasting links its event", async () => {
    const OP = "bbbbbbbb-0000-4000-8000-000000000003";
    await db.query(`select record_tasting($1,$2,$3::jsonb)`, [
      OP,
      cellarId,
      JSON.stringify({ wine_definition_id: wineA, bottle_id: bottleId, rating: 4 }),
    ]);

    const r = await db.query<{ op: string }>(
      `select source_operation_id::text as op from bottle_events
       where bottle_id=$1 and event_type='tasting_recorded'`,
      [bottleId],
    );
    expect(r.rows[0]!.op).toBe(OP);
  });

  it("record_valuation links its event", async () => {
    const OP = "bbbbbbbb-0000-4000-8000-000000000004";
    await db.query(`select record_valuation($1,$2,$3::jsonb)`, [
      OP,
      cellarId,
      JSON.stringify({
        bottle_id: bottleId,
        amount: 700,
        valuation_basis: "market_estimate",
        source: "manual",
      }),
    ]);

    const r = await db.query<{ op: string }>(
      `select source_operation_id::text as op from bottle_events
       where bottle_id=$1 and event_type='valued'`,
      [bottleId],
    );
    expect(r.rows[0]!.op).toBe(OP);
  });

  it("correct_bottle links its event", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarId, wineA, merchantId, userId],
    );
    const OP = "bbbbbbbb-0000-4000-8000-000000000005";

    await db.query(`select correct_bottle($1,$2,$3,$4,$5::jsonb)`, [
      OP,
      b.rows[0]!.id,
      b.rows[0]!.version,
      "Wrong size recorded",
      JSON.stringify({ bottle_size: "1500ml" }),
    ]);

    const r = await db.query<{ op: string; reason: string }>(
      `select source_operation_id::text as op, reason from bottle_events
       where bottle_id=$1 and event_type='corrected'`,
      [b.rows[0]!.id],
    );
    expect(r.rows[0]!.op).toBe(OP);
    expect(r.rows[0]!.reason).toBe("Wrong size recorded");
  });
});

describe("no event anywhere is left unlinked", () => {
  it("every event created by an RPC carries a source operation", async () => {
    // Only events from direct INSERTs in test setup may be null; every event
    // produced by a mutation function must be linked.
    const r = await db.query<{ count: string }>(
      `select count(*)::text from bottle_events where source_operation_id is null`,
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  it("the FK to applied_operations is enforced", async () => {
    const b = await db.query<{ id: string }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id`,
      [cellarId, wineA, merchantId, userId],
    );
    await expect(
      db.query(
        `insert into bottle_events (cellar_id, bottle_id, event_type, source_operation_id)
         values ($1,$2,'moved','99999999-9999-4999-8999-999999999999')`,
        [cellarId, b.rows[0]!.id],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
