// @vitest-environment node

/**
 * THE INVARIANT THE MAPPING DEPENDS ON
 *
 * `bottles.current_value_at` === `valuation_records.created_at`
 *
 * `record_valuation` runs as one transaction and Postgres `now()` is
 * transaction-stable, so the bottle update and the ledger insert receive the
 * identical timestamp. Every part of the currency design rests on that.
 *
 * It is asserted here against a real Postgres engine rather than assumed,
 * because if it ever stopped holding the mapping would silently report every
 * bottle as "unmatched" and quietly drop valuations out of totals.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mapValuationCurrencies,
  distinctCurrencies,
  isResolved,
  type ValuableBottle,
  type ValuationLedgerRow,
} from "@/domain/valuation";

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
  "016_mandatory_wine_type.sql",
];

let db: PGlite;
let cellarId: string;
let userId: string;
let wineId: string;
let bottleIds: string[] = [];

async function value(payload: Record<string, unknown>) {
  await db.query(`select record_valuation(gen_random_uuid(), $1, $2::jsonb)`, [
    cellarId,
    JSON.stringify(payload),
  ]);
}

/** Read bottles and ledger in the shapes the domain mapper expects. */
async function readState(): Promise<{
  bottles: ValuableBottle[];
  rows: ValuationLedgerRow[];
}> {
  const b = await db.query<{
    id: string;
    wine_definition_id: string;
    current_value: string | null;
    current_value_at: string | null;
  }>(
    `select id, wine_definition_id, current_value, current_value_at
      from bottles where cellar_id = $1 order by id`,
    [cellarId],
  );

  const v = await db.query<{
    id: string;
    bottle_id: string | null;
    wine_definition_id: string | null;
    currency: string;
    amount: string;
    valuation_basis: string;
    source: string;
    created_at: string;
  }>(`select * from valuation_records where cellar_id = $1`, [cellarId]);

  return {
    bottles: b.rows.map((r) => ({
      id: r.id,
      wineDefinitionId: r.wine_definition_id,
      currentValue: r.current_value === null ? null : Number(r.current_value),
      currentValueAt: r.current_value_at,
    })),
    rows: v.rows.map((r) => ({
      id: r.id,
      bottleId: r.bottle_id,
      wineDefinitionId: r.wine_definition_id,
      currency: r.currency,
      amount: Number(r.amount),
      valuationBasis: r.valuation_basis,
      source: r.source,
      createdAt: r.created_at,
    })),
  };
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
    `insert into auth.users (email) values ('val@test') returning id`,
  );
  userId = u.rows[0]!.id;
  await db.exec(`set test.user_id = '${userId}'`);
  for (const f of MIGRATIONS) await db.exec(sql(f));

  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Valuation Test', $1) returning id`,
    [userId],
  );
  cellarId = c.rows[0]!.id;

  const w = await db.query<{ create_wine_definition: string }>(
    `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
    [cellarId, JSON.stringify({ producer: "P", name: "Valued Wine", colour: "Red" })],
  );
  wineId = w.rows[0]!.create_wine_definition;

  for (let i = 0; i < 3; i++) {
    const b = await db.query<{ id: string }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id`,
      [cellarId, wineId, userId],
    );
    bottleIds.push(b.rows[0]!.id);
  }
  bottleIds = bottleIds.sort();
}, 60_000);

describe("THE INVARIANT: the cache timestamp equals the ledger timestamp", () => {
  it("holds for a WINE-LEVEL valuation across every bottle", async () => {
    await value({
      wine_definition_id: wineId,
      amount: 150,
      currency: "EUR",
      valuation_basis: "market_estimate",
      source: "manual",
    });

    const r = await db.query<{ exact: boolean }>(
      `select (b.current_value_at = v.created_at) as exact
       from bottles b cross join valuation_records v
       where b.wine_definition_id = $1`,
      [wineId],
    );

    expect(r.rows).toHaveLength(3);
    expect(
      r.rows.every((x) => x.exact),
      "timestamps diverged",
    ).toBe(true);
  });

  it("a wine-level valuation writes ONE ledger row for THREE bottles", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from valuation_records where cellar_id = $1`,
      [cellarId],
    );
    expect(Number(r.rows[0]!.c)).toBe(1);
  });

  it("that row carries NO bottle_id — why bottle_id matching alone fails", async () => {
    const r = await db.query<{ bottle_id: string | null }>(
      `select bottle_id from valuation_records where cellar_id = $1`,
      [cellarId],
    );
    expect(r.rows[0]!.bottle_id).toBeNull();
  });
});

describe("the domain mapper resolves real database state", () => {
  it("resolves all three bottles to EUR", async () => {
    const { bottles, rows } = await readState();
    const m = mapValuationCurrencies(bottles, rows);
    expect([...m.values()].every(isResolved)).toBe(true);
    expect(distinctCurrencies(m)).toEqual(["EUR"]);
  });

  it("a BOTTLE-LEVEL override produces a genuinely mixed-currency holding", async () => {
    await value({
      bottle_id: bottleIds[0],
      amount: 90,
      currency: "GBP",
      valuation_basis: "manual_estimate",
      source: "manual",
    });

    const { bottles, rows } = await readState();
    const m = mapValuationCurrencies(bottles, rows);

    expect(m.get(bottleIds[0]!)).toMatchObject({ currency: "GBP", amount: 90 });
    expect(m.get(bottleIds[1]!)).toMatchObject({ currency: "EUR", amount: 150 });
    expect(distinctCurrencies(m)).toEqual(["EUR", "GBP"]);
  });

  it("NO bottle is ambiguous or unmatched in real state", async () => {
    const { bottles, rows } = await readState();
    const m = mapValuationCurrencies(bottles, rows);
    for (const v of m.values()) {
      expect(isResolved(v), `unresolved: ${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("basis and source survive the round trip", async () => {
    const { bottles, rows } = await readState();
    const m = mapValuationCurrencies(bottles, rows);
    expect(m.get(bottleIds[0]!)).toMatchObject({
      valuationBasis: "manual_estimate",
      source: "manual",
    });
  });
});

describe("consumed bottles keep their historical valuation", () => {
  it("a wine-level revaluation does NOT touch a consumed bottle", async () => {
    // Consume one bottle, then revalue the wine.
    const v = await db.query<{ version: number }>(
      `select version from bottles where id = $1`,
      [bottleIds[2]],
    );
    await db.query(
      `select change_bottle_status(gen_random_uuid(), $1, $2, 'consumed', now())`,
      [bottleIds[2], v.rows[0]!.version],
    );

    await value({
      wine_definition_id: wineId,
      amount: 220,
      currency: "EUR",
      valuation_basis: "auction_estimate",
      source: "auction_house",
    });

    const r = await db.query<{ current_value: string }>(
      `select current_value from bottles where id = $1`,
      [bottleIds[2]],
    );
    // Still the old figure — it left the cellar before the revaluation.
    expect(Number(r.rows[0]!.current_value)).toBe(150);
  });

  it("and it still maps to the OLDER ledger row, not the newest", async () => {
    const { bottles, rows } = await readState();
    const m = mapValuationCurrencies(bottles, rows);
    const consumed = m.get(bottleIds[2]!)!;
    expect(isResolved(consumed)).toBe(true);
    expect((consumed as { amount: number }).amount).toBe(150);
    expect((consumed as { valuationBasis: string }).valuationBasis).toBe("market_estimate");
  });

  it("an active sibling picks up the NEW valuation", async () => {
    const { bottles, rows } = await readState();
    const m = mapValuationCurrencies(bottles, rows);
    expect(m.get(bottleIds[1]!)).toMatchObject({
      amount: 220,
      valuationBasis: "auction_estimate",
      source: "auction_house",
    });
  });
});

describe("read-only guarantees", () => {
  it("valuation_records still has no UPDATE or DELETE policy", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from pg_policies
       where tablename = 'valuation_records' and cmd in ('UPDATE','DELETE')`,
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("migration count is unchanged at 16", () => {
    const files = readFileSync(join(process.cwd(), "db", "016_mandatory_wine_type.sql"));
    expect(files.length).toBeGreaterThan(0);
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const migrations = readdirSync(DB_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f));
    // 17 since migration 017 (extensible bottle size) — approved. The guard
    // still catches any UNAPPROVED migration.
    expect(migrations).toHaveLength(17);
  });
});
