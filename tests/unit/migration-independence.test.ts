// @vitest-environment node

/**
 * MIGRATION SELF-SUFFICIENCY
 *
 * A live deployment failed with:
 *
 *   ERROR: 42883: function is_cellar_owner(uuid) does not exist
 *
 * Cause: 013_rls.sql used a helper defined only in 001_foundation.sql. The
 * test suite never caught it because tests always apply the CURRENT 001, so
 * the function was always present. The live database carried an older 001.
 *
 * A migration that silently depends on another file's function is fragile.
 * These tests apply 013 against a database built from an OLD 001 and assert
 * it still succeeds.
 */

import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = join(process.cwd(), "db");
const sql = (f: string) => readFileSync(join(DB_DIR, f), "utf8");

/** 001 as it existed BEFORE Phase 2.1: no is_cellar_owner, recursive policy. */
function legacy001(): string {
  let s = sql("001_foundation.sql");
  // Strip the helper that Phase 2.1 introduced.
  s = s.replace(
    /create or replace function is_cellar_owner[\s\S]*?\$\$;\n/,
    "-- (is_cellar_owner absent in this older revision)\n",
  );
  // Restore the recursive policy that Phase 2.1 replaced.
  s = s.replace(
    /create policy "owners manage members" on cellar_members\s*\n\s*for all using \(is_cellar_owner\(cellar_id\)\)\s*\n\s*with check \(is_cellar_owner\(cellar_id\)\);/,
    `create policy "owners manage members" on cellar_members
  for all using (
    exists (select 1 from cellar_members m
            where m.cellar_id = cellar_members.cellar_id
              and m.user_id = auth.uid() and m.role = 'owner')
  );`,
  );
  s = s.replace(
    /create policy "owners update cellar" on cellars\s*\n\s*for update using \(is_cellar_owner\(id\)\);/,
    `create policy "owners update cellar" on cellars
  for update using (
    exists (select 1 from cellar_members
            where cellar_id = cellars.id and user_id = auth.uid() and role = 'owner')
  );`,
  );
  return s;
}

const REST = [
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
];

async function baseDb(): Promise<PGlite> {
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
    `insert into auth.users (email) values ('o@t') returning id`,
  );
  await db.exec(`set test.user_id = '${u.rows[0]!.id}'`);
  return db;
}

describe("the legacy-001 fixture is genuinely legacy", () => {
  it("really does omit is_cellar_owner", () => {
    expect(legacy001()).not.toMatch(/create or replace function is_cellar_owner/);
    expect(sql("001_foundation.sql")).toMatch(/create or replace function is_cellar_owner/);
  });

  it("really does contain the recursive policy", () => {
    expect(legacy001()).toMatch(/from cellar_members m/);
  });
});

describe("013 applies against an OLD 001 — the live failure", () => {
  it("reproduces the failure when 013 lacks the helper", async () => {
    // Prove the bug was real: an older 013 body would fail here.
    const db = await baseDb();
    await db.exec(legacy001());
    for (const f of REST) await db.exec(sql(f));

    const missing = await db.query<{ c: string }>(
      `select count(*)::text c from pg_proc
       where pronamespace='public'::regnamespace and proname='is_cellar_owner'`,
    );
    expect(Number(missing.rows[0]!.c)).toBe(0); // absent, as on the live DB

    await expect(
      db.query(`create policy tmp on cellars for update using (is_cellar_owner(id))`),
    ).rejects.toThrow(/does not exist/);
  }, 90_000);

  it("the CURRENT 013 succeeds against an old 001", async () => {
    const db = await baseDb();
    await db.exec(legacy001());
    for (const f of REST) await db.exec(sql(f));
    await expect(db.exec(sql("013_rls.sql"))).resolves.toBeDefined();
  }, 90_000);

  it("013 defines the helper it uses", async () => {
    const db = await baseDb();
    await db.exec(legacy001());
    for (const f of REST) await db.exec(sql(f));
    await db.exec(sql("013_rls.sql"));

    const r = await db.query<{ proname: string; prosecdef: boolean }>(
      `select proname, prosecdef from pg_proc
       where pronamespace='public'::regnamespace
         and proname in ('is_cellar_member','can_edit_cellar','is_cellar_owner')
       order by proname`,
    );
    expect(r.rows.map((x) => x.proname)).toEqual([
      "can_edit_cellar",
      "is_cellar_member",
      "is_cellar_owner",
    ]);
    // All must remain SECURITY DEFINER or the recursion returns.
    expect(r.rows.every((x) => x.prosecdef)).toBe(true);
  }, 90_000);

  it("013 REPAIRS the recursive policy left by an old 001", async () => {
    const db = await baseDb();
    await db.exec(legacy001());

    const before = await db.query<{ qual: string }>(
      `select qual from pg_policies where tablename='cellar_members'
         and policyname='owners manage members'`,
    );
    expect(before.rows[0]!.qual).toMatch(/cellar_members/); // recursive

    for (const f of REST) await db.exec(sql(f));
    await db.exec(sql("013_rls.sql"));

    const after = await db.query<{ qual: string }>(
      `select qual from pg_policies where tablename='cellar_members'
         and policyname='owners manage members'`,
    );
    expect(after.rows[0]!.qual).toMatch(/is_cellar_owner/); // fixed
  }, 90_000);

  it("the repaired policy does not recurse in practice", async () => {
    const db = await baseDb();
    await db.exec(legacy001());
    for (const f of REST) await db.exec(sql(f));
    await db.exec(sql("013_rls.sql"));

    await db.exec(`
      create role app_user nologin;
      grant usage on schema public, auth to app_user;
      grant select, insert, update, delete on all tables in schema public to app_user;
      grant select on auth.users to app_user;
      grant execute on all functions in schema public to app_user;
    `);
    const u = await db.query<{ id: string }>(`select id from auth.users limit 1`);
    await db.query(`insert into cellars (name, created_by) values ('C', $1)`, [
      u.rows[0]!.id,
    ]);

    await db.exec(`set role app_user; set test.user_id = '${u.rows[0]!.id}';`);
    // Under the recursive policy this raises 42P17.
    const r = await db.query<{ c: string }>(`select count(*)::text c from cellar_members`);
    expect(Number(r.rows[0]!.c)).toBe(1);
    await db.exec(`reset role`);
  }, 90_000);
});

describe("every migration declares the functions it uses", () => {
  it("013 does not rely on an undeclared helper", () => {
    const s = sql("013_rls.sql");
    for (const fn of ["is_cellar_member", "can_edit_cellar", "is_cellar_owner"]) {
      if (new RegExp(`${fn}\\(`).test(s)) {
        expect(s, `013 uses ${fn} without defining it`).toMatch(
          new RegExp(`create or replace function ${fn}`),
        );
      }
    }
  });

  it("re-running 013 is idempotent", async () => {
    const db = await baseDb();
    await db.exec(sql("001_foundation.sql"));
    for (const f of REST) await db.exec(sql(f));
    await db.exec(sql("013_rls.sql"));
    await db.exec(sql("013_rls.sql"));
    await db.exec(sql("013_rls.sql"));

    const r = await db.query<{ c: string }>(
      `select count(*)::text c from pg_policies
       where schemaname='public' and tablename='cellar_members'
         and policyname='owners manage members'`,
    );
    expect(Number(r.rows[0]!.c)).toBe(1); // no duplicates
  }, 90_000);
});
