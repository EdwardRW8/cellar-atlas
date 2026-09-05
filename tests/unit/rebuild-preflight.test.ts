// @vitest-environment node

/**
 * DESTRUCTIVE REBUILD — PREFLIGHT & PROFILE CONTINUITY
 *
 * These tests execute the ACTUAL 02-clean-rebuild.sql against a real Postgres
 * engine in each dangerous state. Nothing is simulated: if the interlock does
 * not hold, the tables genuinely get dropped and the assertion fails.
 *
 * Two hazards are covered:
 *
 *   1. The original interlock only checked `bottles` and `wine_definitions`.
 *      A project holding a cellar, members, or configured storage — real work —
 *      would have been destroyed silently.
 *
 *   2. The rebuild preserves auth.users but drops public.profiles. Migration
 *      001's trigger only fires on INSERT, so pre-existing users would have
 *      been left with no profile row. 001 now backfills.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DB_DIR = join(ROOT, "db");
const sql = (f: string) => readFileSync(join(DB_DIR, f), "utf8");
const REBUILD = readFileSync(join(DB_DIR, "deploy", "02-clean-rebuild.sql"), "utf8");

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

/** A database with migrations applied and one authenticated user. */
async function freshDb(): Promise<{ db: PGlite; userId: string }> {
  const db = new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    end $$;
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      encrypted_password text
    );
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select current_setting('test.user_id', true)::uuid $$;
  `);
  const u = await db.query<{ id: string }>(
    `insert into auth.users (email, encrypted_password)
     values ('owner@test','hashed') returning id`,
  );
  const userId = u.rows[0]!.id;
  await db.exec(`set test.user_id = '${userId}'`);
  for (const f of MIGRATIONS) await db.exec(sql(f));
  return { db, userId };
}

/** Did the rebuild refuse? Returns the reason if so. */
async function attemptRebuild(db: PGlite): Promise<{ refused: boolean; reason: string }> {
  try {
    await db.exec(REBUILD);
    return { refused: false, reason: "" };
  } catch (e) {
    return { refused: true, reason: (e as Error).message };
  }
}

const tablesRemain = async (db: PGlite): Promise<number> => {
  const r = await db.query<{ c: string }>(
    `select count(*)::text c from pg_tables where schemaname='public'`,
  );
  return Number(r.rows[0]!.c);
};

// ═══════════════════════════════════════════════════════════════════════════
// THE GAP YOU IDENTIFIED — data with no bottles and no wines
// ═══════════════════════════════════════════════════════════════════════════

describe("preflight refuses when domain data exists WITHOUT bottles or wines", () => {
  it("a cellar but no wines", async () => {
    const { db, userId } = await freshDb();
    await db.query(`insert into cellars (name, created_by) values ('Real Cellar', $1)`, [
      userId,
    ]);

    const { refused, reason } = await attemptRebuild(db);
    expect(refused, "rebuild should have been refused").toBe(true);
    expect(reason).toMatch(/cellars=/);
    expect(await tablesRemain(db)).toBeGreaterThanOrEqual(16);
  }, 60_000);

  it("a membership but no wines", async () => {
    const { db, userId } = await freshDb();
    // The bootstrap trigger creates a membership alongside the cellar.
    await db.query(`insert into cellars (name, created_by) values ('C', $1)`, [userId]);
    const m = await db.query<{ c: string }>(`select count(*)::text c from cellar_members`);
    expect(Number(m.rows[0]!.c)).toBeGreaterThan(0);

    const { refused, reason } = await attemptRebuild(db);
    expect(refused).toBe(true);
    expect(reason).toMatch(/cellar_members=/);
  }, 60_000);

  it("a storage location but no wines", async () => {
    const { db, userId } = await freshDb();
    const c = await db.query<{ id: string }>(
      `insert into cellars (name, created_by) values ('C', $1) returning id`,
      [userId],
    );
    await db.query(
      `select create_storage_layout(gen_random_uuid(), $1, 'Rack', 'grid', '{"rows":2,"columns":2}'::jsonb)`,
      [c.rows[0]!.id],
    );

    const { refused, reason } = await attemptRebuild(db);
    expect(refused).toBe(true);
    expect(reason).toMatch(/storage_layouts=/);
  }, 60_000);

  it("a cellar profile but no wines", async () => {
    const { db, userId } = await freshDb();
    const c = await db.query<{ id: string }>(
      `insert into cellars (name, created_by) values ('C', $1) returning id`,
      [userId],
    );
    await db.query(
      `insert into cellar_profiles (cellar_id, bottles_per_month) values ($1, 4)`,
      [c.rows[0]!.id],
    );

    const { refused, reason } = await attemptRebuild(db);
    expect(refused).toBe(true);
    expect(reason).toMatch(/cellar_profiles=/);
  }, 60_000);

  it("an acquisition but no bottles", async () => {
    const { db, userId } = await freshDb();
    const c = await db.query<{ id: string }>(
      `insert into cellars (name, created_by) values ('C', $1) returning id`,
      [userId],
    );
    await db.query(`insert into acquisitions (cellar_id, source) values ($1, 'Merchant')`, [
      c.rows[0]!.id,
    ]);

    const { refused, reason } = await attemptRebuild(db);
    expect(refused).toBe(true);
    expect(reason).toMatch(/acquisitions=/);
  }, 60_000);

  it("an applied operation but nothing else", async () => {
    const { db, userId } = await freshDb();
    const c = await db.query<{ id: string }>(
      `insert into cellars (name, created_by) values ('C', $1) returning id`,
      [userId],
    );
    await db.query(
      `insert into applied_operations (operation_id, cellar_id, entity, entity_id, operation)
       values (gen_random_uuid(), $1, 'wine_definition', gen_random_uuid(), 'create')`,
      [c.rows[0]!.id],
    );

    const { refused, reason } = await attemptRebuild(db);
    expect(refused).toBe(true);
    expect(reason).toMatch(/applied_operations=/);
  }, 60_000);

  it("normal wine and bottle data", async () => {
    const { db, userId } = await freshDb();
    const c = await db.query<{ id: string }>(
      `insert into cellars (name, created_by) values ('C', $1) returning id`,
      [userId],
    );
    const w = await db.query<{ create_wine_definition: string }>(
      `select create_wine_definition(gen_random_uuid(), $1, '{"producer":"P","name":"N"}'::jsonb)`,
      [c.rows[0]!.id],
    );
    await db.query(
      `insert into bottles (cellar_id, wine_definition_id, created_by) values ($1,$2,$3)`,
      [c.rows[0]!.id, w.rows[0]!.create_wine_definition, userId],
    );

    const { refused, reason } = await attemptRebuild(db);
    expect(refused).toBe(true);
    expect(reason).toMatch(/bottles=|wine_definitions=/);
    expect(await tablesRemain(db)).toBeGreaterThanOrEqual(16);
  }, 60_000);

  it("names every blocking table in the message, not just one", async () => {
    const { db, userId } = await freshDb();
    const c = await db.query<{ id: string }>(
      `insert into cellars (name, created_by) values ('C', $1) returning id`,
      [userId],
    );
    await db.query(`insert into acquisitions (cellar_id, source) values ($1,'M')`, [
      c.rows[0]!.id,
    ]);

    const { reason } = await attemptRebuild(db);
    expect(reason).toMatch(/acquisitions=/);
    expect(reason).toMatch(/cellars=/);
    expect(reason).toMatch(/cellar_members=/);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CLEAN CASE MUST STILL WORK
// ═══════════════════════════════════════════════════════════════════════════

describe("preflight ALLOWS a genuinely clean development database", () => {
  it("proceeds when only reference data and an auth user exist", async () => {
    const { db } = await freshDb();
    // geo_regions is seeded, heartbeat may have rows, one auth user exists.
    const geo = await db.query<{ c: string }>(`select count(*)::text c from geo_regions`);
    expect(Number(geo.rows[0]!.c)).toBeGreaterThan(150);

    const { refused, reason } = await attemptRebuild(db);
    expect(refused, `refused unexpectedly: ${reason}`).toBe(false);

    // Domain tables genuinely gone.
    const remaining = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname='public' order by tablename`,
    );
    expect(remaining.rows.map((r) => r.tablename)).toEqual([]);
  }, 60_000);

  it("seeded geography does not block the rebuild", async () => {
    const { db } = await freshDb();
    const { refused } = await attemptRebuild(db);
    expect(refused).toBe(false);
  }, 60_000);

  it("heartbeat rows do not block the rebuild", async () => {
    const { db } = await freshDb();
    await db.query(`select ping()`);
    await db.query(`select ping()`);
    const hb = await db.query<{ c: string }>(`select count(*)::text c from heartbeat`);
    expect(Number(hb.rows[0]!.c)).toBeGreaterThan(0);

    const { refused } = await attemptRebuild(db);
    expect(refused).toBe(false);
  }, 60_000);

  it("a profile row alone does not block the rebuild", async () => {
    const { db } = await freshDb();
    const p = await db.query<{ c: string }>(`select count(*)::text c from profiles`);
    expect(Number(p.rows[0]!.c)).toBe(1); // backfilled by 001

    const { refused } = await attemptRebuild(db);
    expect(refused).toBe(false);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// WRONG-PROJECT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

describe("refuses to run against the V2 database", () => {
  it("aborts if V2's `wines` table is present", async () => {
    const { db } = await freshDb();
    await db.exec(`create table wines (id uuid primary key default gen_random_uuid());`);

    const { refused, reason } = await attemptRebuild(db);
    expect(refused).toBe(true);
    expect(reason).toMatch(/V2 database/);
    expect(await tablesRemain(db)).toBeGreaterThan(0);
  }, 60_000);

  it("aborts if V2's `change_log` table is present", async () => {
    const { db } = await freshDb();
    await db.exec(
      `create table change_log (id uuid primary key default gen_random_uuid());`,
    );

    const { refused, reason } = await attemptRebuild(db);
    expect(refused).toBe(true);
    expect(reason).toMatch(/V2 database/);
  }, 60_000);

  it("the V2 check runs BEFORE the data check", async () => {
    // A V2-looking but empty database must still abort with the V2 message,
    // not fall through to "no data, proceed".
    const { db } = await freshDb();
    await db.exec(`create table wines (id uuid primary key default gen_random_uuid());`);
    const { reason } = await attemptRebuild(db);
    expect(reason).toMatch(/V2 database/);
    expect(reason).not.toMatch(/domain data/);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// PROFILE CONTINUITY ACROSS A REBUILD
// ═══════════════════════════════════════════════════════════════════════════

describe("an auth user survives a rebuild with exactly one profile", () => {
  let db: PGlite;
  let userId: string;
  let userEmail: string;

  beforeEach(async () => {
    const fresh = await freshDb();
    db = fresh.db;
    userId = fresh.userId;
    const u = await db.query<{ email: string }>(
      `select email from auth.users where id = $1`,
      [userId],
    );
    userEmail = u.rows[0]!.email;
  }, 60_000);

  it("has exactly one profile before the rebuild", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from profiles where user_id = $1`,
      [userId],
    );
    expect(Number(r.rows[0]!.c)).toBe(1);
  });

  it("the auth user still exists after the rebuild", async () => {
    await db.exec(REBUILD);
    const r = await db.query<{ id: string; email: string; encrypted_password: string }>(
      `select id, email, encrypted_password from auth.users where id = $1`,
      [userId],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.email).toBe(userEmail);
    // Credentials intact — the user can still sign in.
    expect(r.rows[0]!.encrypted_password).toBe("hashed");
  }, 60_000);

  it("public.profiles is genuinely dropped by the rebuild", async () => {
    await db.exec(REBUILD);
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from pg_tables
       where schemaname='public' and tablename='profiles'`,
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  }, 60_000);

  it("migration 001 backfills exactly ONE profile for the existing user", async () => {
    await db.exec(REBUILD);
    await db.exec(sql("001_foundation.sql"));

    const r = await db.query<{ c: string }>(
      `select count(*)::text c from profiles where user_id = $1`,
      [userId],
    );
    expect(Number(r.rows[0]!.c), "user must have exactly one profile").toBe(1);
  }, 60_000);

  it("the backfilled profile carries the correct email", async () => {
    await db.exec(REBUILD);
    await db.exec(sql("001_foundation.sql"));

    const r = await db.query<{ email: string }>(
      `select email from profiles where user_id = $1`,
      [userId],
    );
    expect(r.rows[0]!.email).toBe(userEmail);
  }, 60_000);

  it("re-running 001 does NOT create a duplicate profile", async () => {
    await db.exec(REBUILD);
    await db.exec(sql("001_foundation.sql"));
    await db.exec(sql("001_foundation.sql")); // idempotency
    await db.exec(sql("001_foundation.sql"));

    const r = await db.query<{ c: string }>(
      `select count(*)::text c from profiles where user_id = $1`,
      [userId],
    );
    expect(Number(r.rows[0]!.c)).toBe(1);
  }, 60_000);

  it("backfills EVERY pre-existing user, not just one", async () => {
    // Three more users created before the rebuild.
    for (const e of ["a@test", "b@test", "c@test"]) {
      await db.query(
        `insert into auth.users (email, encrypted_password)
                      values ($1,'hashed')`,
        [e],
      );
    }
    const before = await db.query<{ c: string }>(`select count(*)::text c from auth.users`);
    expect(Number(before.rows[0]!.c)).toBe(4);

    await db.exec(REBUILD);
    await db.exec(sql("001_foundation.sql"));

    const profiles = await db.query<{ c: string }>(`select count(*)::text c from profiles`);
    expect(Number(profiles.rows[0]!.c)).toBe(4);

    // Every user matched to exactly one profile — none missing, none orphaned.
    const orphans = await db.query<{ c: string }>(
      `select count(*)::text c from auth.users u
       where not exists (select 1 from profiles p where p.user_id = u.id)`,
    );
    expect(Number(orphans.rows[0]!.c), "users left without a profile").toBe(0);
  }, 60_000);

  it("the trigger still works for users created AFTER the rebuild", async () => {
    await db.exec(REBUILD);
    await db.exec(sql("001_foundation.sql"));

    await db.query(`insert into auth.users (email, encrypted_password)
                    values ('new@test','hashed')`);
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from profiles where email = 'new@test'`,
    );
    expect(Number(r.rows[0]!.c)).toBe(1);
  }, 60_000);

  it("a full rebuild plus all migrations leaves a working database", async () => {
    await db.exec(REBUILD);
    for (const f of MIGRATIONS) await db.exec(sql(f));

    // Profile present, geography reseeded, and the user can create a cellar.
    const p = await db.query<{ c: string }>(
      `select count(*)::text c from profiles where user_id = $1`,
      [userId],
    );
    expect(Number(p.rows[0]!.c)).toBe(1);

    const geo = await db.query<{ c: string }>(`select count(*)::text c from geo_regions`);
    expect(Number(geo.rows[0]!.c)).toBeGreaterThan(150);

    await db.exec(`set test.user_id = '${userId}'`);
    const c = await db.query<{ id: string }>(
      `insert into cellars (name, created_by) values ('Post-Rebuild', $1) returning id`,
      [userId],
    );
    const m = await db.query<{ role: string }>(
      `select role from cellar_members where cellar_id = $1`,
      [c.rows[0]!.id],
    );
    expect(m.rows[0]!.role).toBe("owner");
  }, 90_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SCRIPT ITSELF
// ═══════════════════════════════════════════════════════════════════════════

describe("the rebuild script is explicit about its danger", () => {
  it("warns that it is V3-only and destructive", () => {
    expect(REBUILD).toMatch(/DESTRUCTIVE/);
    expect(REBUILD).toMatch(/V3 DEVELOPMENT PROJECT ONLY/);
    expect(REBUILD).toMatch(/V2 LIVES IN A SEPARATE SUPABASE PROJECT/);
  });

  it("names the V2 project id so it cannot be confused", () => {
    expect(REBUILD).toMatch(/iadaahmjvzctwmtnixpq/);
  });

  it("prints the preflight report before the destructive section", () => {
    const reportAt = REBUILD.indexOf("preflight_rebuild_report()");
    const destructiveAt = REBUILD.indexOf("DESTRUCTIVE SECTION BELOW");
    expect(reportAt).toBeGreaterThan(-1);
    expect(destructiveAt).toBeGreaterThan(reportAt);
  });

  it("checks every domain table, not just bottles and wines", () => {
    for (const t of [
      "cellars",
      "cellar_members",
      "cellar_profiles",
      "storage_layouts",
      "storage_locations",
      "wine_definitions",
      "acquisitions",
      "acquisition_items",
      "bottles",
      "bottle_events",
      "tasting_records",
      "valuation_records",
      "applied_operations",
    ]) {
      expect(REBUILD, `preflight omits ${t}`).toMatch(new RegExp(`'${t}'`));
    }
  });

  it("explicitly ignores reference and derived tables", () => {
    expect(REBUILD).toMatch(/'geo_regions', 'heartbeat', 'profiles'/);
  });
});
