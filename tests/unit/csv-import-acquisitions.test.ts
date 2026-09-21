// @vitest-environment node

/**
 * MULTI-ACQUISITION IMPORT — AGAINST THE REAL RPCs
 *
 * The workbook is a cellar built over years, so one import yields one
 * acquisition PER TRUTHFUL PURCHASE IDENTITY. This drives the real parser,
 * planner and grouping, then sends each group to the real
 * `create_acquisition_with_items` in exactly the shape execute() builds.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "@/domain/csv-import/parse";
import { planImport, stableOperationId } from "@/domain/csv-import/plan";
import {
  planAcquisitions,
  summariseAcquisitions,
  importReferencePrefix,
  groupKeyOf,
  type PlannedAcquisition,
} from "@/domain/csv-import/acquisitions";
import {
  applyImportIntegrityChecks,
  resolveStatusTargets,
  statusAction,
} from "@/domain/csv-import/status";
import { buildPhase11Csv } from "../e2e/fixtures/phase11-csv";

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

const HEADER =
  "Producer,Wine Name,Vintage,Wine Type,Quantity,Status,Bottle Size ml," +
  "Purchase Price per Bottle,Purchase Currency,Purchase Date,Merchant / Source";

async function planFor(csv: string, attemptId = "attempt-1", fp = "f".repeat(64)) {
  const rows = applyImportIntegrityChecks(parseCsv(csv).rows);
  const plan = await planImport({
    rows,
    attemptId,
    fingerprint: fp,
    existingWines: [],
    locations: [],
    newId: () => crypto.randomUUID(),
    parsePositionKey: () => null,
  });
  const groups = await planAcquisitions({ plan, rows, attemptId, fileFingerprint: fp });
  return { rows, plan, groups };
}

let db: PGlite;
let cellarId: string;

/** The acquisition payload execute() builds — unknowns OMITTED, never defaulted. */
function header(g: PlannedAcquisition) {
  return {
    ...(g.identity.currency ? { currency: g.identity.currency } : {}),
    ...(g.identity.purchasedOn ? { purchased_on: g.identity.purchasedOn } : {}),
    ...(g.identity.merchant ? { source: g.identity.merchant } : {}),
    reference: g.reference,
  };
}

async function wine(name: string) {
  const r = await db.query<{ create_wine_definition: string }>(
    `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
    [cellarId, JSON.stringify({ producer: "Multi", name, colour: "Red" })],
  );
  return r.rows[0]!.create_wine_definition;
}

async function send(g: PlannedAcquisition, wineIds: Map<string, string>) {
  const items = g.items.map((i) => ({
    wine_definition_id: wineIds.get(i.wineKey),
    quantity: i.quantity,
    bottle_size: i.bottleSize,
    unit_price: i.unitPrice,
  }));
  const r = await db.query<{ create_acquisition_with_items: string }>(
    `select create_acquisition_with_items($1, $2, $3::jsonb, $4::jsonb)`,
    [g.operationId, cellarId, JSON.stringify(header(g)), JSON.stringify(items)],
  );
  return r.rows[0]!.create_acquisition_with_items;
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
      language sql stable as $$ select current_setting('test.user_id', true)::uuid $$;`);
  const u = await db.query<{ id: string }>(
    `insert into auth.users (email) values ('m@t') returning id`,
  );
  await db.exec(`set test.user_id = '${u.rows[0]!.id}'`);
  for (const f of MIGRATIONS) await db.exec(readFileSync(join(DB, f), "utf8"));
  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Multi', $1) returning id`,
    [u.rows[0]!.id],
  );
  cellarId = c.rows[0]!.id;
}, 90_000);

describe("grouping is truthful and deterministic", () => {
  it("the E2E fixture forms exactly three acquisitions", async () => {
    const { groups } = await planFor(buildPhase11Csv("unit").csv);
    expect(groups).toHaveLength(3);
  });

  it("price, quantity and wine are NOT part of the key", async () => {
    // One purchase holding two wines at different prices and quantities.
    const { groups } = await planFor(
      [
        HEADER,
        "A,One,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
        "B,Two,2019,White,6,In cellar,750,95,GBP,2022-05-01,Berry Bros",
      ].join("\n"),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("the documented examples split exactly as specified", async () => {
    const { groups } = await planFor(
      [
        HEADER,
        "A,One,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
        "B,Two,2018,Red,1,In cellar,750,30,GBP,2022-05-01,The Wine Society",
        "C,Three,2018,Red,1,In cellar,750,30,GBP,2023-09-12,Berry Bros",
        "D,Four,2018,Red,1,In cellar,750,30,GBP,,",
        "E,Five,2018,Red,1,In cellar,750,,,,",
      ].join("\n"),
    );
    expect(groups).toHaveLength(5);
  });

  it("an unknown date is NOT borrowed from another row", async () => {
    const { groups } = await planFor(
      [
        HEADER,
        "A,One,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
        "B,Two,2018,Red,1,In cellar,750,30,GBP,,Berry Bros",
      ].join("\n"),
    );
    const dates = groups.map((g) => g.identity.purchasedOn).sort();
    expect(dates).toEqual(["2022-05-01", null].sort());
  });

  it("row order does not change groups, keys or operation ids", async () => {
    const lines = [
      "A,One,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
      "B,Two,2018,Red,1,In cellar,750,40,EUR,2023-09-12,Caves",
    ];
    const x = await planFor([HEADER, ...lines].join("\n"));
    const y = await planFor([HEADER, ...[...lines].reverse()].join("\n"));
    expect(x.groups.map((g) => [g.key, g.operationId])).toEqual(
      y.groups.map((g) => [g.key, g.operationId]),
    );
  });

  it("a different ATTEMPT gets different operation ids for the same groups", async () => {
    const csv = [
      HEADER,
      "A,One,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
    ].join("\n");
    const a = await planFor(csv, "attempt-A");
    const b = await planFor(csv, "attempt-B");
    expect(a.groups[0]!.operationId).not.toBe(b.groups[0]!.operationId);
    // ...but the same reference, so the file is still detected.
    expect(a.groups[0]!.reference).toBe(b.groups[0]!.reference);
  });
});

describe("cost is never mixed across currencies", () => {
  it("one line per currency, each with its own total", async () => {
    const { groups, rows } = await planFor(
      [
        HEADER,
        "A,One,2018,Red,2,In cellar,750,42.50,EUR,2024-03-01,Test Merchant",
        "B,Two,2018,Red,1,In cellar,375,18.00,GBP,2023-09-12,Other Merchant",
      ].join("\n"),
    );
    const s = summariseAcquisitions(groups, rows);
    expect(s.costByCurrency).toEqual([
      { currency: "EUR", amount: 85, pricedBottles: 2 },
      { currency: "GBP", amount: 18, pricedBottles: 1 },
    ]);
    expect(s.currencies).toEqual(["EUR", "GBP"]);
  });

  it("unpriced bottles contribute NO cost", async () => {
    const { groups, rows } = await planFor(
      [HEADER, "A,One,2018,Red,3,In cellar,750,,,,"].join("\n"),
    );
    expect(summariseAcquisitions(groups, rows).costByCurrency).toEqual([]);
    expect(groups[0]!.cost).toBeNull();
    expect(groups[0]!.unpricedBottles).toBe(3);
  });

  it("counts rows with unknown date and merchant", async () => {
    const { groups, rows } = await planFor(
      [
        HEADER,
        "A,One,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
        "B,Two,2018,Red,1,In cellar,750,,,,",
      ].join("\n"),
    );
    const s = summariseAcquisitions(groups, rows);
    expect(s.rowsWithUnknownDate).toBe(1);
    expect(s.rowsWithUnknownMerchant).toBe(1);
  });
});

describe("REAL RPCs: each group is recorded truthfully", () => {
  let groups: PlannedAcquisition[];
  const ids = new Map<string, string>();
  const acq = new Map<string, string>();

  beforeAll(async () => {
    ({ groups } = await planFor(
      [
        HEADER,
        "A,Euro Wine,2018,Red,2,In cellar,750,42.50,EUR,2024-03-01,Test Merchant",
        "B,Sterling Wine,2020,Red,1,In cellar,375,18.00,GBP,2023-09-12,Other Merchant",
        "C,Unknown Wine,2019,Red,1,In cellar,750,,,,",
      ].join("\n"),
      "rpc-attempt",
    ));
    for (const g of groups)
      for (const i of g.items) ids.set(i.wineKey, await wine(`line-${i.lineNumber}`));
    for (const g of groups) acq.set(g.key, await send(g, ids));
  });

  const row = async (g: PlannedAcquisition) =>
    (
      await db.query<{
        currency: string;
        purchased_on: string | null;
        source: string | null;
        reference: string;
      }>(
        `select currency, purchased_on::text, source, reference from acquisitions where id = $1`,
        [acq.get(g.key)],
      )
    ).rows[0]!;
  const byCurrency = (c: string | null) => groups.find((g) => g.identity.currency === c)!;

  it("creates THREE acquisitions", () => {
    expect(new Set(acq.values()).size).toBe(3);
  });

  it("EUR stays EUR, with its own date and merchant", async () => {
    expect(await row(byCurrency("EUR"))).toMatchObject({
      currency: "EUR",
      purchased_on: "2024-03-01",
      source: "Test Merchant",
    });
  });

  it("GBP stays GBP, with its own date and merchant", async () => {
    expect(await row(byCurrency("GBP"))).toMatchObject({
      currency: "GBP",
      purchased_on: "2023-09-12",
      source: "Other Merchant",
    });
  });

  it("the unknown group keeps date and merchant NULL — nothing invented", async () => {
    const r = await row(byCurrency(null));
    expect(r.purchased_on).toBeNull();
    expect(r.source).toBeNull();
  });

  it("the unknown group's forced currency sits on NO money", async () => {
    // currency is NOT NULL, so the RPC writes its default — but every item's
    // unit_price is NULL, and cost is only ever read from unit_price.
    const items = await db.query<{ unit_price: string | null }>(
      `select unit_price from acquisition_items where acquisition_id = $1`,
      [acq.get(byCurrency(null).key)],
    );
    expect(items.rows.every((i) => i.unit_price === null)).toBe(true);
  });

  it("each cost stays in its own acquisition's currency", async () => {
    const r = await db.query<{ currency: string; unit_price: string; quantity: number }>(
      `select a.currency, ai.unit_price, ai.quantity from acquisition_items ai
       join acquisitions a on a.id = ai.acquisition_id
       where ai.unit_price is not null order by a.currency`,
    );
    expect(r.rows.map((x) => [x.currency, Number(x.unit_price), x.quantity])).toEqual([
      ["EUR", 42.5, 2],
      ["GBP", 18, 1],
    ]);
  });

  it("every reference shares the file prefix, and a LIKE finds all three", async () => {
    const prefix = importReferencePrefix("f".repeat(64));
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from acquisitions where reference like $1`,
      [`${prefix}%`],
    );
    expect(r.rows[0]!.n).toBe(3);
  });

  it("a DIFFERENT file's prefix matches nothing", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from acquisitions where reference like $1`,
      [`${importReferencePrefix("0".repeat(64))}%`],
    );
    expect(r.rows[0]!.n).toBe(0);
  });

  it("REPLAYING every group creates no acquisitions and no bottles", async () => {
    const count = async () =>
      (
        await db.query<{ a: number; b: number }>(
          `select (select count(*) from acquisitions)::int as a, (select count(*) from bottles)::int as b`,
        )
      ).rows[0]!;
    const before = await count();
    for (const g of groups)
      expect(await send(g, ids), "replay returns the original").toBe(acq.get(g.key));
    expect(await count()).toEqual(before);
  });
});

describe("REAL RPCs: status is resolved per acquisition", () => {
  it("identical items in DIFFERENT acquisitions keep their own statuses", async () => {
    const csv = [
      HEADER,
      "Estate,Twin,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
      "Estate,Twin,2018,Red,1,Consumed,750,30,GBP,2023-09-12,Berry Bros",
    ].join("\n");
    const { rows, plan, groups } = await planFor(csv, "twin-attempt");
    expect(
      rows.every((r) => r.severity !== "invalid"),
      "not a conflict: different purchases",
    ).toBe(true);
    expect(groups).toHaveLength(2);

    const wineIds = new Map([[plan.items[0]!.wineKey, await wine("Twin")]]);
    const statusByLine = new Map(plan.statusChanges.map((c) => [c.lineNumber, c.status]));

    for (const g of groups) {
      const acqId = await send(g, wineIds);
      const items = await db.query<{
        id: string;
        wine_definition_id: string;
        quantity: number;
        bottle_size: string;
        unit_price: string | null;
      }>(
        `select id, wine_definition_id, quantity, bottle_size, unit_price from acquisition_items where acquisition_id = $1`,
        [acqId],
      );
      const bottles = await db.query<{
        id: string;
        version: number;
        status: string;
        acquisition_item_id: string;
      }>(
        `select id, version, status, acquisition_item_id from bottles where acquisition_item_id = any($1::uuid[])`,
        [items.rows.map((i) => i.id)],
      );
      const res = resolveStatusTargets({
        planned: g.items.map((i) => ({
          lineNumber: i.lineNumber,
          wineId: wineIds.get(i.wineKey)!,
          quantity: i.quantity,
          bottleSize: i.bottleSize,
          unitPrice: i.unitPrice,
          status: statusByLine.get(i.lineNumber) ?? "in_cellar",
        })),
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
      });
      for (const t of res.targets) {
        await db.query(`select change_bottle_status($1, $2, $3, $4, now(), $5)`, [
          await stableOperationId("twin-attempt", statusAction(t.bottleId)),
          t.bottleId,
          t.version,
          t.status,
          t.reason ?? null,
        ]);
      }
    }

    const r = await db.query<{ purchased_on: string; status: string }>(
      `select a.purchased_on::text, b.status from bottles b
       join acquisition_items ai on ai.id = b.acquisition_item_id
       join acquisitions a on a.id = ai.acquisition_id
       where ai.wine_definition_id = $1 order by a.purchased_on`,
      [wineIds.values().next().value],
    );
    // 2022 purchase stays in the cellar; the 2023 one was consumed.
    expect(r.rows).toEqual([
      { purchased_on: "2022-05-01", status: "in_cellar" },
      { purchased_on: "2023-09-12", status: "consumed" },
    ]);
  });

  it("group keys differ, so the conflict rule no longer over-blocks", () => {
    const [a, b] = parseCsv(
      [
        HEADER,
        "Estate,Twin,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
        "Estate,Twin,2018,Red,1,Consumed,750,30,GBP,2023-09-12,Berry Bros",
      ].join("\n"),
    ).rows;
    expect(groupKeyOf(a!)).not.toBe(groupKeyOf(b!));
  });
});

describe("REAL RPCs: generic storage and provenance, never exercised before", () => {
  it("rows in ONE purchase land in THEIR OWN locations", async () => {
    const mk = async (name: string, kind: string) =>
      (
        await db.query<{ id: string }>(
          `insert into storage_locations (cellar_id, name, kind, is_external)
         values ($1, $2, $3, $4) returning id`,
          [cellarId, name, kind, kind === "merchant"],
        )
      ).rows[0]!.id;
    const home = await mk("Home Store", "home");
    const merchant = await mk("Merchant Reserve", "merchant");

    const w1 = await wine("Loc One");
    const w2 = await wine("Loc Two");
    const acqId = (
      await db.query<{ create_acquisition_with_items: string }>(
        `select create_acquisition_with_items($1, $2, $3::jsonb, $4::jsonb)`,
        [
          "abababab-abab-4bab-8bab-abababababab",
          cellarId,
          JSON.stringify({}),
          JSON.stringify([
            // exactly the item shape execute() sends: location PER ITEM
            {
              wine_definition_id: w1,
              quantity: 2,
              bottle_size: "750ml",
              unit_price: null,
              storage_location_id: home,
              positions: [null, null],
            },
            {
              wine_definition_id: w2,
              quantity: 1,
              bottle_size: "750ml",
              unit_price: null,
              storage_location_id: merchant,
              positions: [null],
            },
          ]),
        ],
      )
    ).rows[0]!.create_acquisition_with_items;

    const r = await db.query<{
      wine_definition_id: string;
      storage_location_id: string;
      position: unknown;
    }>(
      `select b.wine_definition_id, b.storage_location_id, b.position from bottles b
       join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1 order by b.wine_definition_id`,
      [acqId],
    );
    expect(
      r.rows
        .filter((b) => b.wine_definition_id === w1)
        .every((b) => b.storage_location_id === home),
    ).toBe(true);
    expect(
      r.rows
        .filter((b) => b.wine_definition_id === w2)
        .every((b) => b.storage_location_id === merchant),
    ).toBe(true);
    expect(
      r.rows.every((b) => b.position === null),
      "located but unpositioned",
    ).toBe(true);
  });

  it("CONTROL: without storage_location_id the bottle has NO location", async () => {
    // Why the per-item location had to be sent: previously it never was.
    const w = await wine("No Location");
    const acqId = (
      await db.query<{ create_acquisition_with_items: string }>(
        `select create_acquisition_with_items($1, $2, '{}'::jsonb, $3::jsonb)`,
        [
          "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
          cellarId,
          JSON.stringify([
            { wine_definition_id: w, quantity: 1, bottle_size: "750ml", unit_price: null },
          ]),
        ],
      )
    ).rows[0]!.create_acquisition_with_items;
    const r = await db.query<{ storage_location_id: string | null }>(
      `select b.storage_location_id from bottles b join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1`,
      [acqId],
    );
    expect(r.rows[0]!.storage_location_id).toBeNull();
  });

  it("a valuation's source REFERENCE is stored in the ledger's notes", async () => {
    const w = await wine("Referenced Value");
    await db.query(`select record_valuation(gen_random_uuid(), $1, $2::jsonb)`, [
      cellarId,
      JSON.stringify({
        wine_definition_id: w,
        amount: 90,
        currency: "GBP",
        valuation_basis: "market_estimate",
        source: "import",
        valued_on: "2026-09-19",
        notes: "Source reference: https://merchant.example/wine/7",
      }),
    ]);
    const r = await db.query<{ source: string; notes: string; valued_on: string }>(
      `select source, notes, valued_on::text from valuation_records where wine_definition_id = $1`,
      [w],
    );
    expect(r.rows[0]).toEqual({
      source: "import",
      notes: "Source reference: https://merchant.example/wine/7",
      valued_on: "2026-09-19",
    });
  });
});
