// @vitest-environment node

/**
 * CSV IMPORT STATUS — AGAINST THE REAL RPCs
 *
 * The resolver is pure, but the property that matters is behavioural: after
 * `create_acquisition_with_items` really runs, do the right bottles — and only
 * those — leave the cellar, with the right audit trail, and does a retry add
 * nothing? This runs the actual migrations and RPCs on a Postgres engine and
 * reads back by foreign key exactly as the repository does.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveStatusTargets,
  statusAction,
  type PlannedStatusItem,
} from "@/domain/csv-import/status";
import { stableOperationId } from "@/domain/csv-import/plan";

const DB = join(process.cwd(), "db");
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
  "016_mandatory_wine_type.sql",
];

let db: PGlite;
let cellarId: string;

async function wine(name: string): Promise<string> {
  const r = await db.query<{ create_wine_definition: string }>(
    `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
    [cellarId, JSON.stringify({ producer: "Status Test", name, colour: "Red" })],
  );
  return r.rows[0]!.create_wine_definition;
}

/** Runs the acquisition exactly as the importer sends it. */
async function acquire(
  operationId: string,
  items: Record<string, unknown>[],
  acquisition: Record<string, unknown> = {},
): Promise<string> {
  const r = await db.query<{ create_acquisition_with_items: string }>(
    `select create_acquisition_with_items($1, $2, $3::jsonb, $4::jsonb)`,
    [operationId, cellarId, JSON.stringify(acquisition), JSON.stringify(items)],
  );
  return r.rows[0]!.create_acquisition_with_items;
}

/** The repository's two FK-keyed reads, verbatim in intent. */
async function readBack(acquisitionId: string) {
  const items = await db.query<{
    id: string;
    wine_definition_id: string;
    quantity: number;
    bottle_size: string;
    unit_price: string | null;
  }>(
    `select id, wine_definition_id, quantity, bottle_size, unit_price
     from acquisition_items where acquisition_id = $1`,
    [acquisitionId],
  );
  const bottles = await db.query<{
    id: string;
    version: number;
    status: string;
    acquisition_item_id: string;
  }>(
    `select id, version, status, acquisition_item_id from bottles
     where acquisition_item_id = any($1::uuid[])`,
    [items.rows.map((i) => i.id)],
  );
  return {
    created: items.rows.map((i) => ({
      id: i.id,
      wineDefinitionId: i.wine_definition_id,
      quantity: i.quantity,
      bottleSize: i.bottle_size,
      unitPrice: i.unit_price,
    })),
    bottles: bottles.rows.map((b) => ({
      id: b.id,
      version: b.version,
      status: b.status,
      acquisitionItemId: b.acquisition_item_id,
    })),
  };
}

/** Apply resolved targets with stable ids, exactly as execute() does. */
async function applyStatuses(
  attemptId: string,
  planned: PlannedStatusItem[],
  acqId: string,
) {
  const { created, bottles } = await readBack(acqId);
  const resolution = resolveStatusTargets({ planned, created, bottles });
  for (const t of resolution.targets) {
    const op = await stableOperationId(attemptId, statusAction(t.bottleId));
    await db.query(`select change_bottle_status($1, $2, $3, $4, now(), $5)`, [
      op,
      t.bottleId,
      t.version,
      t.status,
      t.reason ?? null,
    ]);
  }
  return resolution;
}

async function statusesByItem(acqId: string) {
  const r = await db.query<{ quantity: number; status: string; n: number }>(
    `select ai.quantity, b.status, count(*)::int as n
     from bottles b join acquisition_items ai on ai.id = b.acquisition_item_id
     where ai.acquisition_id = $1
     group by ai.quantity, b.status order by ai.quantity, b.status`,
    [acqId],
  );
  return r.rows;
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
    `insert into auth.users (email) values ('status@test') returning id`,
  );
  await db.exec(`set test.user_id = '${u.rows[0]!.id}'`);
  for (const f of MIGRATIONS) await db.exec(readFileSync(join(DB, f), "utf8"));
  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Status', $1) returning id`,
    [u.rows[0]!.id],
  );
  cellarId = c.rows[0]!.id;
}, 90_000);

describe("THE CROSSING CASE: two rows of the SAME wine keep their own statuses", () => {
  it("only the Consumed row's bottles leave the cellar", async () => {
    const w = await wine("Same Wine Two Rows");
    // Row 2: 1 bottle, in the cellar. Row 3: 2 bottles, consumed. Same wine.
    const acq = await acquire("11111111-1111-4111-8111-111111111111", [
      { wine_definition_id: w, quantity: 1, bottle_size: "750ml", unit_price: 30 },
      { wine_definition_id: w, quantity: 2, bottle_size: "750ml", unit_price: 30 },
    ]);

    const planned: PlannedStatusItem[] = [
      {
        lineNumber: 2,
        wineId: w,
        quantity: 1,
        bottleSize: "750ml",
        unitPrice: 30,
        status: "in_cellar",
      },
      {
        lineNumber: 3,
        wineId: w,
        quantity: 2,
        bottleSize: "750ml",
        unitPrice: 30,
        status: "consumed",
      },
    ];
    const res = await applyStatuses("attempt-cross", planned, acq);
    expect(res.failures).toEqual([]);

    // The qty-1 item stays in the cellar; BOTH bottles of the qty-2 item leave.
    expect(await statusesByItem(acq)).toEqual([
      { quantity: 1, status: "in_cellar", n: 1 },
      { quantity: 2, status: "consumed", n: 2 },
    ]);
  });

  it("the reverse assignment is equally exact", async () => {
    const w = await wine("Reverse Rows");
    const acq = await acquire("22222222-2222-4222-8222-222222222222", [
      { wine_definition_id: w, quantity: 1, bottle_size: "750ml", unit_price: 30 },
      { wine_definition_id: w, quantity: 2, bottle_size: "750ml", unit_price: 30 },
    ]);
    await applyStatuses(
      "attempt-reverse",
      [
        {
          lineNumber: 2,
          wineId: w,
          quantity: 1,
          bottleSize: "750ml",
          unitPrice: 30,
          status: "consumed",
        },
        {
          lineNumber: 3,
          wineId: w,
          quantity: 2,
          bottleSize: "750ml",
          unitPrice: 30,
          status: "in_cellar",
        },
      ],
      acq,
    );

    expect(await statusesByItem(acq)).toEqual([
      { quantity: 1, status: "consumed", n: 1 },
      { quantity: 2, status: "in_cellar", n: 2 },
    ]);
  });
});

describe("quantity 2, non-active: BOTH physical bottles move", () => {
  let acq: string;

  beforeAll(async () => {
    const w = await wine("Drunk Pair");
    acq = await acquire("33333333-3333-4333-8333-333333333333", [
      { wine_definition_id: w, quantity: 2, bottle_size: "750ml", unit_price: null },
    ]);
    await applyStatuses(
      "attempt-pair",
      [
        {
          lineNumber: 2,
          wineId: w,
          quantity: 2,
          bottleSize: "750ml",
          unitPrice: null,
          status: "consumed",
        },
      ],
      acq,
    );
  });

  it("two bottle rows exist, both consumed", async () => {
    expect(await statusesByItem(acq)).toEqual([{ quantity: 2, status: "consumed", n: 2 }]);
  });

  it("each has an ADDED event followed by a CONSUMED event", async () => {
    const r = await db.query<{ bottle_id: string; events: string[] }>(
      `select e.bottle_id, array_agg(e.event_type order by e.occurred_at, e.id) as events
       from bottle_events e
       join bottles b on b.id = e.bottle_id
       join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1 group by e.bottle_id`,
      [acq],
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row.events).toEqual(["added", "consumed"]);
  });

  it("neither counts as active inventory", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from bottles b
       join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1 and b.status = 'in_cellar'`,
      [acq],
    );
    expect(r.rows[0]!.n).toBe(0);
  });
});

describe("retry does not duplicate status events", () => {
  it("replaying the same attempt adds no events and changes nothing", async () => {
    const w = await wine("Retried Pair");
    const op = "44444444-4444-4444-8444-444444444444";
    const items = [
      { wine_definition_id: w, quantity: 2, bottle_size: "750ml", unit_price: 25 },
    ];
    const planned: PlannedStatusItem[] = [
      {
        lineNumber: 2,
        wineId: w,
        quantity: 2,
        bottleSize: "750ml",
        unitPrice: 25,
        status: "consumed",
      },
    ];

    const acq = await acquire(op, items);
    await applyStatuses("attempt-retry", planned, acq);

    const count = async () =>
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from bottle_events e join bottles b on b.id = e.bottle_id
         join acquisition_items ai on ai.id = b.acquisition_item_id
         where ai.acquisition_id = $1`,
          [acq],
        )
      ).rows[0]!.n;
    const before = await count();

    // Full replay: the acquisition returns the ORIGINAL id, and every status
    // change replays through claim_operation before its version check.
    const again = await acquire(op, items);
    expect(again, "acquisition replay must return the original id").toBe(acq);
    const res = await applyStatuses("attempt-retry", planned, again);

    expect(res.failures).toEqual([]);
    expect(await count(), "no new events on retry").toBe(before);
    expect(await statusesByItem(acq)).toEqual([{ quantity: 2, status: "consumed", n: 2 }]);
  });
});

describe("active and removed rows", () => {
  it("an In cellar row stays active", async () => {
    const w = await wine("Stays Home");
    const acq = await acquire("55555555-5555-4555-8555-555555555555", [
      { wine_definition_id: w, quantity: 3, bottle_size: "750ml", unit_price: 10 },
    ]);
    const res = await applyStatuses(
      "attempt-active",
      [
        {
          lineNumber: 2,
          wineId: w,
          quantity: 3,
          bottleSize: "750ml",
          unitPrice: 10,
          status: "in_cellar",
        },
      ],
      acq,
    );
    expect(res.targets).toEqual([]);
    expect(await statusesByItem(acq)).toEqual([{ quantity: 3, status: "in_cellar", n: 3 }]);
  });

  it("a Removed row leaves the cellar WITH the required reason", async () => {
    const w = await wine("Gone");
    const acq = await acquire("66666666-6666-4666-8666-666666666666", [
      { wine_definition_id: w, quantity: 1, bottle_size: "750ml", unit_price: null },
    ]);
    const res = await applyStatuses(
      "attempt-removed",
      [
        {
          lineNumber: 2,
          wineId: w,
          quantity: 1,
          bottleSize: "750ml",
          unitPrice: null,
          status: "removed",
        },
      ],
      acq,
    );
    expect(res.failures).toEqual([]);
    expect(await statusesByItem(acq)).toEqual([{ quantity: 1, status: "removed", n: 1 }]);

    const e = await db.query<{ reason: string | null }>(
      `select reason from bottle_events e join bottles b on b.id = e.bottle_id
       join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1 and e.event_type = 'removed'`,
      [acq],
    );
    expect(e.rows[0]!.reason).toMatch(/CSV import/);
  });
});

describe("the currency the file supplied is the currency recorded", () => {
  it("EUR stays EUR — the RPC's GBP fallback is never reached", async () => {
    const w = await wine("Euro Purchase");
    const acq = await acquire(
      "77777777-7777-4777-8777-777777777777",
      [{ wine_definition_id: w, quantity: 1, bottle_size: "750ml", unit_price: 40 }],
      { currency: "EUR", purchased_on: "2024-03-01", source: "Test Merchant" },
    );
    const r = await db.query<{ currency: string; purchased_on: string; source: string }>(
      `select currency, purchased_on::text, source from acquisitions where id = $1`,
      [acq],
    );
    expect(r.rows[0]).toEqual({
      currency: "EUR",
      purchased_on: "2024-03-01",
      source: "Test Merchant",
    });
  });

  it("CONTROL: omitting currency really does become GBP — why it must be sent", async () => {
    const w = await wine("Omitted Currency");
    const acq = await acquire("88888888-8888-4888-8888-888888888888", [
      { wine_definition_id: w, quantity: 1, bottle_size: "750ml", unit_price: 40 },
    ]);
    const r = await db.query<{ currency: string }>(
      `select currency from acquisitions where id = $1`,
      [acq],
    );
    expect(r.rows[0]!.currency).toBe("GBP");
  });
});

describe("a mismatched read-back changes nothing", () => {
  it("fewer bottles than planned → no status change, reported", async () => {
    const w = await wine("Mismatch");
    const acq = await acquire("99999999-9999-4999-8999-999999999999", [
      { wine_definition_id: w, quantity: 1, bottle_size: "750ml", unit_price: 5 },
    ]);
    // The plan claims two bottles; the database holds one.
    const res = await applyStatuses(
      "attempt-mismatch",
      [
        {
          lineNumber: 2,
          wineId: w,
          quantity: 2,
          bottleSize: "750ml",
          unitPrice: 5,
          status: "consumed",
        },
      ],
      acq,
    );
    expect(res.targets).toEqual([]);
    expect(res.failures).toHaveLength(1);
    expect(await statusesByItem(acq)).toEqual([{ quantity: 1, status: "in_cellar", n: 1 }]);
  });
});
