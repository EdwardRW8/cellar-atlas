// @vitest-environment node

/**
 * FRESH-USER CELLAR CREATION — AGAINST THE REAL MIGRATIONS
 *
 * A brand-new account could not create its first cellar. Every screen failed
 * with "new row violates row-level security policy for table cellars".
 *
 * The INSERT was never the problem. `.select("id").single()` adds a RETURNING
 * clause, so Postgres checks the new row against the SELECT policy
 * `is_cellar_member(id)` — which is evaluated BEFORE the AFTER INSERT trigger
 * `trg_cellar_owner` creates the membership that policy looks for.
 *
 * These run the repository's own migrations unmodified. No policy, trigger or
 * migration is changed by the fix.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DB = join(process.cwd(), "db");
const MIGRATIONS = readdirSync(DB)
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort();

let db: PGlite;

/** Run as the signed-in user: the GUC must be set BEFORE switching role. */
async function asUser(userId: string, sql: string, params: unknown[] = []) {
  await db.exec(`set test.user_id = '${userId}'`);
  await db.exec(`set role authenticated`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`reset role`);
  }
}

async function newUser(email: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`,
    [email],
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
      language sql stable as $$ select current_setting('test.user_id', true)::uuid $$;`);
  for (const f of MIGRATIONS) await db.exec(readFileSync(join(DB, f), "utf8"));
  // Supabase grants these by default; PGlite does not. Without them the tests
  // would fail on GRANTs before RLS was ever evaluated.
  await db.exec(`
    grant usage on schema public, auth to authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant execute on all functions in schema public to authenticated;`);
}, 120_000);

describe("THE BUG: the old statement is refused for a fresh user", () => {
  it("INSERT … RETURNING is refused by the SELECT policy", async () => {
    const user = await newUser("old-way@test");
    await expect(
      asUser(
        user,
        `insert into cellars (name, created_by) values ('My Cellar', $1) returning id`,
        [user],
      ),
    ).rejects.toThrow(/row-level security|row level security/i);
  });

  it("…and no cellar is left behind", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from cellars where name = 'My Cellar'`,
    );
    expect(r.rows[0]!.n).toBe(0);
  });
});

describe("THE FIX: a client-generated id with no RETURNING", () => {
  let user: string;
  let cellarId: string;

  beforeAll(async () => {
    user = await newUser("new-way@test");
    cellarId = crypto.randomUUID();
    await asUser(
      user,
      `insert into cellars (id, name, created_by) values ($1, 'My Cellar', $2)`,
      [cellarId, user],
    );
  });

  it("the insert succeeds", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from cellars where id = $1`,
      [cellarId],
    );
    expect(r.rows[0]!.n).toBe(1);
  });

  it("the trigger grants the creator ownership", async () => {
    const r = await db.query<{ role: string }>(
      `select role from cellar_members where cellar_id = $1 and user_id = $2`,
      [cellarId, user],
    );
    expect(r.rows.map((x) => x.role)).toEqual(["owner"]);
  });

  it("the cellar is then readable BY THAT USER under RLS", async () => {
    const r = await asUser(user, `select id from cellars where id = $1`, [cellarId]);
    expect((r.rows as { id: string }[]).map((x) => x.id)).toEqual([cellarId]);
  });

  it("and is NOT readable by anyone else — RLS is not weakened", async () => {
    const stranger = await newUser("stranger@test");
    const r = await asUser(stranger, `select id from cellars where id = $1`, [cellarId]);
    expect(r.rows).toEqual([]);
  });

  it("a user still cannot create a cellar owned by someone else", async () => {
    const other = await newUser("victim@test");
    await expect(
      asUser(user, `insert into cellars (id, name, created_by) values ($1, 'Theirs', $2)`, [
        crypto.randomUUID(),
        other,
      ]),
    ).rejects.toThrow(/row-level security|row level security/i);
  });
});

describe("the repository matches what the database requires", () => {
  const SRC = readFileSync("src/data/repositories/cellar-repository.ts", "utf8");

  it("createFirstCellar generates the id and does NOT read the row back", () => {
    const fn = SRC.slice(SRC.indexOf("static async createFirstCellar"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    expect(body).toMatch(/crypto\.randomUUID\(\)/);
    expect(body).toMatch(
      /\.insert\(\{ id, name: "My Cellar", created_by: user\.user\.id \}\)/,
    );
    expect(body, "a .select() here reintroduces the bug").not.toMatch(/\.select\(/);
    expect(body).not.toMatch(/\.single\(/);
  });

  it("resolveCellar no longer creates anything", () => {
    const fn = SRC.slice(SRC.indexOf("static async resolveCellar"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    expect(body).not.toMatch(/\.insert\(/);
    expect(body).toMatch(/return null;/);
  });

  it("no migration, policy or trigger was touched", () => {
    // Not pinned to a count: gate 12.5 adds 019, and this test is about the
    // hotfix adding none of its own, not about how many exist overall.
    // The migration-count guard proper lives in phase3-architecture.test.ts.
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(18);
    expect(MIGRATIONS).toContain("001_foundation.sql");
    const foundation = readFileSync(join(DB, "001_foundation.sql"), "utf8");
    expect(foundation).toMatch(/create policy "create cellars"/);
    expect(foundation).toMatch(/trg_cellar_owner/);
  });
});
