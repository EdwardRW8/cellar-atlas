// @vitest-environment node

/**
 * INSPECTION SCRIPT ROBUSTNESS
 *
 * The original script did `select ... from geo_regions` without first
 * establishing that the table existed. Against a partially deployed project
 * it aborted with:
 *
 *   ERROR: 42P01: relation "geo_regions" does not exist
 *
 * An inspection tool that crashes on the schema it is meant to inspect is
 * worse than useless — it is exactly the state where you most need it to work.
 *
 * These tests run the ACTUAL script against four real schema states and
 * assert it completes, reports missing tables rather than failing, and
 * reaches a sensible verdict. They also assert it is read-only.
 */

import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = join(process.cwd(), "db");
const sql = (f: string) => readFileSync(join(DB_DIR, f), "utf8");
const INSPECT = readFileSync(
  join(DB_DIR, "deploy", "01-inspect-current-state.sql"),
  "utf8",
);

const ALL_MIGRATIONS = [
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

interface Row {
  section: string;
  item: string;
  detail: string;
}

/** A database with the Supabase auth stubs and the given migrations applied. */
async function dbWith(migrations: string[]): Promise<PGlite> {
  const db = new PGlite();
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
  await db.exec(`set test.user_id = '${u.rows[0]!.id}'`);
  for (const f of migrations) await db.exec(sql(f));
  return db;
}

async function inspect(db: PGlite): Promise<Row[]> {
  const r = await db.query<Row>(INSPECT);
  return r.rows;
}

const find = (rows: Row[], needle: string) => rows.find((r) => r.item.includes(needle));

const verdict = (rows: Row[]) => find(rows, "RECOMMENDED ACTION")?.detail ?? "";

// ═══════════════════════════════════════════════════════════════════════════
// STATE 1 — COMPLETELY EMPTY PUBLIC SCHEMA
// ═══════════════════════════════════════════════════════════════════════════

describe("state 1: completely empty public schema", () => {
  it("completes without error", async () => {
    const db = await dbWith([]);
    const rows = await inspect(db);
    expect(rows.length).toBeGreaterThan(20);
  }, 60_000);

  it("reports every table as NOT PRESENT rather than aborting", async () => {
    const db = await dbWith([]);
    const rows = await inspect(db);
    const tableRows = rows.filter(
      (r) => r.section === "2. TABLES" && r.item.startsWith("Table:"),
    );
    expect(tableRows).toHaveLength(16);
    expect(tableRows.every((r) => r.detail.startsWith("NOT PRESENT"))).toBe(true);
  }, 60_000);

  it("names the migration that would create each missing table", async () => {
    const db = await dbWith([]);
    const rows = await inspect(db);
    expect(find(rows, "Table: geo_regions")?.detail).toMatch(/migration 002 not applied/);
    expect(find(rows, "Table: bottles")?.detail).toMatch(/migration 007 not applied/);
  }, 60_000);

  it("handles the geography check that previously crashed", async () => {
    const db = await dbWith([]);
    const rows = await inspect(db);
    expect(find(rows, "Geography reference data")?.detail).toMatch(
      /NOT PRESENT — migration 002 not applied/,
    );
    expect(find(rows, "Geography provenance")?.detail).toBe("NOT PRESENT");
  }, 60_000);

  it("reports zero domain rows, not an error", async () => {
    const db = await dbWith([]);
    const rows = await inspect(db);
    expect(find(rows, "TOTAL DOMAIN ROWS")?.detail).toMatch(/^0/);
  }, 60_000);

  it("still counts auth.users", async () => {
    const db = await dbWith([]);
    const rows = await inspect(db);
    expect(find(rows, "auth.users")?.detail).toBe("1");
  }, 60_000);

  it("recommends PATH A — apply all migrations", async () => {
    const db = await dbWith([]);
    expect(verdict(await inspect(db))).toMatch(/PATH A/);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// STATE 2 — PHASE 1 ONLY
// ═══════════════════════════════════════════════════════════════════════════

describe("state 2: Phase 1 only (001)", () => {
  it("completes without error", async () => {
    const db = await dbWith(["001_foundation.sql"]);
    const rows = await inspect(db);
    expect(rows.length).toBeGreaterThan(20);
  }, 60_000);

  it("reports 5 of 16 tables present", async () => {
    const db = await dbWith(["001_foundation.sql"]);
    const rows = await inspect(db);
    expect(find(rows, "Tables present")?.detail).toBe("5 of 16");
  }, 60_000);

  it("distinguishes present from absent correctly", async () => {
    const db = await dbWith(["001_foundation.sql"]);
    const rows = await inspect(db);
    expect(find(rows, "Table: cellars")?.detail).toBe("present");
    expect(find(rows, "Table: applied_operations")?.detail).toBe("present");
    expect(find(rows, "Table: geo_regions")?.detail).toMatch(/NOT PRESENT/);
    expect(find(rows, "Table: bottles")?.detail).toMatch(/NOT PRESENT/);
  }, 60_000);

  it("geography check survives with 002 unapplied", async () => {
    const db = await dbWith(["001_foundation.sql"]);
    const rows = await inspect(db);
    expect(find(rows, "Geography reference data")?.detail).toMatch(/NOT PRESENT/);
  }, 60_000);

  it("reports the recursion fix as present", async () => {
    const db = await dbWith(["001_foundation.sql"]);
    const rows = await inspect(db);
    expect(find(rows, "Membership policy")?.detail).toMatch(/FIXED/);
  }, 60_000);

  it("reports bottle_events checks as not applicable", async () => {
    const db = await dbWith(["001_foundation.sql"]);
    const rows = await inspect(db);
    expect(find(rows, "Event operation model")?.detail).toMatch(
      /migration 009 not applied/,
    );
    expect(find(rows, "bottles.deleted_at")?.detail).toMatch(/migration 007 not applied/);
  }, 60_000);

  it("recommends PATH B — partial deployment", async () => {
    const db = await dbWith(["001_foundation.sql"]);
    expect(verdict(await inspect(db))).toMatch(/PATH B/);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// STATE 3 — PARTIALLY MIGRATED PHASE 2
// ═══════════════════════════════════════════════════════════════════════════

describe("state 3: partially migrated Phase 2 (001–007)", () => {
  const PARTIAL = ALL_MIGRATIONS.slice(0, 7); // through 007_bottles

  it("completes without error", async () => {
    const db = await dbWith(PARTIAL);
    const rows = await inspect(db);
    expect(rows.length).toBeGreaterThan(20);
  }, 60_000);

  it("reports 12 of 16 tables present", async () => {
    const db = await dbWith(PARTIAL);
    const rows = await inspect(db);
    expect(find(rows, "Tables present")?.detail).toBe("12 of 16");
  }, 60_000);

  it("geo_regions EXISTS and is counted — the original crash case", async () => {
    const db = await dbWith(PARTIAL);
    const rows = await inspect(db);
    const geo = find(rows, "Geography reference data")?.detail ?? "";
    expect(geo).toMatch(/\d+ rows/);
    expect(geo).not.toMatch(/NOT PRESENT/);
  }, 60_000);

  it("bottle_events is absent and reported as such", async () => {
    const db = await dbWith(PARTIAL);
    const rows = await inspect(db);
    expect(find(rows, "Table: bottle_events")?.detail).toMatch(/migration 009 not applied/);
    expect(find(rows, "Data: bottle_events")?.detail).toBe("NOT PRESENT");
  }, 60_000);

  it("mixes present and absent data counts without failing", async () => {
    const db = await dbWith(PARTIAL);
    const rows = await inspect(db);
    expect(find(rows, "Data: bottles")?.detail).toBe("0");
    expect(find(rows, "Data: geo_regions")?.detail).toMatch(/^\d+$/);
    expect(find(rows, "Data: tasting_records")?.detail).toBe("NOT PRESENT");
  }, 60_000);

  it("recommends PATH B — partial deployment", async () => {
    const db = await dbWith(PARTIAL);
    expect(verdict(await inspect(db))).toMatch(/PATH B/);
  }, 60_000);

  it("survives an unusual partial state — 001 and 002 but not 003", async () => {
    const db = await dbWith(["001_foundation.sql", "002_geography.sql"]);
    const rows = await inspect(db);
    // Table exists but is empty because the seed never ran.
    expect(find(rows, "Geography reference data")?.detail).toMatch(
      /table exists but empty — migration 003 not applied/,
    );
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// STATE 4 — FULLY MIGRATED PHASE 2.2
// ═══════════════════════════════════════════════════════════════════════════

describe("state 4: fully migrated Phase 2.2", () => {
  it("completes without error", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const rows = await inspect(db);
    expect(rows.length).toBeGreaterThan(20);
  }, 90_000);

  it("reports all 16 tables present", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const rows = await inspect(db);
    expect(find(rows, "Tables present")?.detail).toBe("16 of 16");
  }, 90_000);

  it("confirms RLS on every table", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const rows = await inspect(db);
    expect(find(rows, "RLS enabled")?.detail).toMatch(/all present tables protected/);
  }, 90_000);

  it("confirms the current schema markers", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const rows = await inspect(db);
    expect(find(rows, "Event operation model")?.detail).toMatch(/Phase 2.1 applied/);
    expect(find(rows, "bottles.deleted_at")?.detail).toMatch(/absent — correct/);
    expect(find(rows, "Membership policy")?.detail).toMatch(/FIXED/);
  }, 90_000);

  it("counts geography with provenance intact", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const rows = await inspect(db);
    expect(find(rows, "Geography reference data")?.detail).toMatch(/\d{3} rows/);
    expect(find(rows, "Geography provenance")?.detail).toMatch(
      /missing source: 0, claiming boundaries: 0/,
    );
  }, 90_000);

  it("confirms all 16 functions and none wrongly SECURITY DEFINER", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const rows = await inspect(db);
    expect(find(rows, "Mutation functions present")?.detail).toBe("16 of 16");
    expect(find(rows, "wrongly SECURITY DEFINER")?.detail).toMatch(/none/);
  }, 90_000);

  it("confirms no DELETE or immutable-table UPDATE policies", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const rows = await inspect(db);
    expect(find(rows, "DELETE policies")?.detail).toMatch(/none — correct/);
    expect(find(rows, "UPDATE policies on immutable")?.detail).toMatch(/none — correct/);
  }, 90_000);

  it("recommends PATH E — current and empty, skip the rebuild", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    expect(verdict(await inspect(db))).toMatch(/PATH E/);
  }, 90_000);

  it("switches to PATH D once domain data exists", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const u = await db.query<{ id: string }>(`select id from auth.users limit 1`);
    await db.query(`insert into cellars (name, created_by) values ('Real', $1)`, [
      u.rows[0]!.id,
    ]);

    const rows = await inspect(db);
    expect(find(rows, "TOTAL DOMAIN ROWS")?.detail).toMatch(/REBUILD WILL BE REFUSED/);
    expect(verdict(rows)).toMatch(/PATH D/);
    expect(verdict(rows)).toMatch(/Do NOT rebuild/);
  }, 90_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// WRONG PROJECT — safe when V2 tables are absent AND when present
// ═══════════════════════════════════════════════════════════════════════════

describe("V2 signature check is safe either way", () => {
  it("reports OK when V2 tables are absent", async () => {
    const db = await dbWith([]);
    const rows = await inspect(db);
    expect(find(rows, "Project identity")?.detail).toMatch(/OK — no V2 signature/);
  }, 60_000);

  it("detects V2 even on an otherwise empty schema", async () => {
    const db = await dbWith([]);
    await db.exec(`create table wines (id uuid primary key default gen_random_uuid());`);
    const rows = await inspect(db);
    expect(find(rows, "Project identity")?.detail).toMatch(/WRONG Supabase project/);
    expect(verdict(rows)).toMatch(/STOP\. This is the V2 project/);
  }, 60_000);

  it("detects V2 via change_log", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    await db.exec(
      `create table change_log (id uuid primary key default gen_random_uuid());`,
    );
    const rows = await inspect(db);
    expect(find(rows, "Project identity")?.detail).toMatch(/WRONG Supabase project/);
  }, 90_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// READ-ONLY GUARANTEE
// ═══════════════════════════════════════════════════════════════════════════

describe("the inspection changes nothing", () => {
  it("contains no DDL or DML statements", () => {
    const forbidden = [
      /\bcreate\s+table\b/i,
      /\bcreate\s+or\s+replace\s+function\b/i,
      /\bdrop\s+table\b/i,
      /\bdrop\s+function\b/i,
      /\balter\s+table\b/i,
      /\binsert\s+into\b/i,
      /\bupdate\s+\w+\s+set\b/i,
      /\bdelete\s+from\b/i,
      /\btruncate\b/i,
      /\bgrant\b/i,
    ];
    for (const re of forbidden) {
      expect(INSPECT, `script contains ${re}`).not.toMatch(re);
    }
  });

  it("leaves table and function counts unchanged", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const before = await db.query<{ t: string; f: string }>(
      `select (select count(*)::text from pg_tables where schemaname='public') t,
              (select count(*)::text from pg_proc where pronamespace='public'::regnamespace) f`,
    );
    await inspect(db);
    const after = await db.query<{ t: string; f: string }>(
      `select (select count(*)::text from pg_tables where schemaname='public') t,
              (select count(*)::text from pg_proc where pronamespace='public'::regnamespace) f`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  }, 90_000);

  it("leaves row counts unchanged", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const before = await db.query<{ c: string }>(
      `select count(*)::text c from geo_regions`,
    );
    await inspect(db);
    const after = await db.query<{ c: string }>(`select count(*)::text c from geo_regions`);
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  }, 90_000);

  it("can be run repeatedly with identical results", async () => {
    const db = await dbWith(ALL_MIGRATIONS);
    const first = await inspect(db);
    const second = await inspect(db);
    const third = await inspect(db);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  }, 90_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// REGRESSION — the specific failure reported
// ═══════════════════════════════════════════════════════════════════════════

describe("regression: 42P01 relation does not exist", () => {
  it("no bare SELECT FROM an application table", () => {
    // Every table read must be guarded. The only permitted FROM targets are
    // catalog relations, CTEs defined in the script, and query_to_xml.
    //
    // String literals and comments are stripped first: `qual ilike
    // '%from cellar_members%'` is a pg_policies predicate, not a table read,
    // and matching inside quotes would be a false positive.
    const stripped = INSPECT.split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .replace(/'[^']*'/g, "''"); // remove single-quoted literals

    const appTables = [
      "cellars",
      "cellar_members",
      "profiles",
      "applied_operations",
      "heartbeat",
      "geo_regions",
      "wine_definitions",
      "storage_layouts",
      "storage_locations",
      "acquisitions",
      "acquisition_items",
      "bottles",
      "bottle_events",
      "tasting_records",
      "valuation_records",
      "cellar_profiles",
    ];

    for (const t of appTables) {
      const bare = new RegExp(`\\bfrom\\s+(public\\.)?${t}\\b`, "gi");
      const hits = stripped.match(bare) ?? [];
      expect(hits, `unguarded read of ${t}: ${hits.join(" | ")}`).toHaveLength(0);
    }
  });

  it("the literal-stripping in the previous test actually works", () => {
    // Guard against the guard: if stripping silently removed everything, the
    // test above would pass vacuously.
    const stripped = INSPECT.replace(/'[^']*'/g, "''");
    expect(stripped).toMatch(/from expected/); // real CTE references remain
    expect(stripped).toMatch(/join pg_tables/); // catalog reads remain
    expect(stripped).toMatch(/from information_schema\.columns/);
    expect(stripped.length).toBeGreaterThan(1000);
  });

  it("every dynamic count is guarded by the existing CTE", () => {
    // query_to_xml must only ever receive tables proven to exist.
    expect(INSPECT).toMatch(/from existing x/);
    expect(INSPECT).toMatch(/join pg_tables t on t\.schemaname = 'public'/);
  });

  it("auth.users access is guarded by to_regclass", () => {
    expect(INSPECT).toMatch(/to_regclass\('auth\.users'\)/);
  });

  it("reproduces the original scenario without error", async () => {
    // The exact state that broke it: some migrations applied, geo_regions absent.
    const db = await dbWith(["001_foundation.sql"]);
    await expect(inspect(db)).resolves.toBeDefined();
  }, 60_000);
});
