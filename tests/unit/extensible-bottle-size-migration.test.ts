// @vitest-environment node

/**
 * MIGRATION 017 — EXTENSIBLE BOTTLE SIZE, AGAINST A REAL POSTGRES ENGINE
 *
 * The migration drops inline, UNNAMED constraints, so the tests that matter
 * most are the ones proving it drops only what it should.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DB = join(process.cwd(), "db");
const BEFORE_017 = readdirSync(DB)
  .filter((f) => /^0(0\d|1[0-6])_.*\.sql$/.test(f))
  .sort();
const M017 = readFileSync(join(DB, "017_extensible_bottle_size.sql"), "utf8");

async function freshDb(): Promise<{
  db: PGlite;
  cellarId: string;
  wineId: string;
  userId: string;
}> {
  const db = new PGlite();
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
    `insert into auth.users (email) values ('size@t') returning id`,
  );
  const userId = u.rows[0]!.id;
  await db.exec(`set test.user_id = '${userId}'`);
  for (const f of BEFORE_017) await db.exec(readFileSync(join(DB, f), "utf8"));
  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Sizes', $1) returning id`,
    [userId],
  );
  const w = await db.query<{ create_wine_definition: string }>(
    `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
    [c.rows[0]!.id, JSON.stringify({ producer: "P", name: "Size Wine", colour: "Red" })],
  );
  return { db, cellarId: c.rows[0]!.id, wineId: w.rows[0]!.create_wine_definition, userId };
}

/** Every CHECK on the two tables, excluding the bottle_size-only ones. */
async function otherChecks(db: PGlite) {
  const r = await db.query<{ t: string; def: string }>(`
    select conrelid::regclass::text as t, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid in ('acquisition_items'::regclass, 'bottles'::regclass)
      and contype = 'c'
      and not (conkey = array[(select attnum from pg_attribute
                                where attrelid = conrelid and attname = 'bottle_size')])
    order by 1, 2`);
  return r.rows;
}

describe("applied to a database holding existing bottles", () => {
  let db: PGlite, cellarId: string, wineId: string, userId: string;
  let before: { t: string; def: string }[];
  const OLD = ["375ml", "750ml", "1500ml", "3000ml", "6000ml"];

  beforeAll(async () => {
    ({ db, cellarId, wineId, userId } = await freshDb());
    for (const size of OLD) {
      await db.query(
        `insert into bottles (cellar_id, wine_definition_id, bottle_size, created_by) values ($1,$2,$3,$4)`,
        [cellarId, wineId, size, userId],
      );
    }
    before = await otherChecks(db);
    await db.exec(M017);
  }, 90_000);

  const insert = (size: string) =>
    db.query(
      `insert into bottles (cellar_id, wine_definition_id, bottle_size, created_by) values ($1,$2,$3,$4)`,
      [cellarId, wineId, size, userId],
    );

  it("keeps every existing bottle, unchanged", async () => {
    const r = await db.query<{ bottle_size: string }>(
      `select bottle_size from bottles where cellar_id = $1 order by bottle_size`,
      [cellarId],
    );
    expect(r.rows.map((x) => x.bottle_size).sort()).toEqual([...OLD].sort());
  });

  it("every existing value is still valid", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from bottles where not is_valid_bottle_size(bottle_size)`,
    );
    expect(r.rows[0]!.n).toBe(0);
  });

  it("accepts legitimate uncommon sizes — 200, 250, 500, 1000, 30000", async () => {
    for (const size of ["200ml", "250ml", "500ml", "1000ml", "30000ml"]) {
      await expect(insert(size), size).resolves.toBeTruthy();
    }
  });

  it("REJECTS malformed sizes at the database, not only in the app", async () => {
    for (const bad of [
      "0ml",
      "-200ml",
      "abc",
      "750",
      "750 ml",
      "",
      "0750ml",
      "750ML",
      "7.5ml",
      "60000ml",
      "99999ml",
    ]) {
      await expect(insert(bad), JSON.stringify(bad)).rejects.toThrow(/check constraint/i);
    }
  });

  it("the default is still 750ml", async () => {
    const r = await db.query<{ bottle_size: string }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by) values ($1,$2,$3) returning bottle_size`,
      [cellarId, wineId, userId],
    );
    expect(r.rows[0]!.bottle_size).toBe("750ml");
  });

  it("EVERY OTHER CHECK on both tables is untouched", async () => {
    expect(await otherChecks(db)).toEqual(before);
    expect(
      before.length,
      "sanity: there were other checks to protect",
    ).toBeGreaterThanOrEqual(6);
  });

  it("each table now has exactly ONE bottle_size check, the named one", async () => {
    const r = await db.query<{ conname: string }>(`
      select conname from pg_constraint
      where contype = 'c' and conrelid in ('acquisition_items'::regclass, 'bottles'::regclass)
        and conkey = array[(select attnum from pg_attribute where attrelid = conrelid and attname = 'bottle_size')]
      order by conname`);
    expect(r.rows.map((x) => x.conname)).toEqual([
      "acquisition_items_bottle_size_canonical",
      "bottles_bottle_size_canonical",
    ]);
  });

  it("the acquisition RPC creates a 200ml bottle", async () => {
    const r = await db.query<{ create_acquisition_with_items: string }>(
      `select create_acquisition_with_items(gen_random_uuid(), $1, '{}'::jsonb, $2::jsonb)`,
      [
        cellarId,
        JSON.stringify([{ wine_definition_id: wineId, quantity: 1, bottle_size: "200ml" }]),
      ],
    );
    const b = await db.query<{ bottle_size: string }>(
      `select b.bottle_size from bottles b join acquisition_items ai on ai.id = b.acquisition_item_id
       where ai.acquisition_id = $1`,
      [r.rows[0]!.create_acquisition_with_items],
    );
    expect(b.rows[0]!.bottle_size).toBe("200ml");
  });

  it("correct_bottle accepts a new canonical size and refuses a malformed one", async () => {
    const r = await db.query<{ id: string; version: number }>(
      `select id, version from bottles where cellar_id = $1 and bottle_size = '750ml' limit 1`,
      [cellarId],
    );
    const { id, version } = r.rows[0]!;
    await db.query(
      `select correct_bottle(gen_random_uuid(), $1, $2, 'mislabelled', $3::jsonb)`,
      [id, version, JSON.stringify({ bottle_size: "500ml" })],
    );
    const after = await db.query<{ bottle_size: string }>(
      `select bottle_size from bottles where id = $1`,
      [id],
    );
    expect(after.rows[0]!.bottle_size).toBe("500ml");

    await expect(
      db.query(`select correct_bottle(gen_random_uuid(), $1, $2, 'typo', $3::jsonb)`, [
        id,
        version + 1,
        JSON.stringify({ bottle_size: "abc" }),
      ]),
    ).rejects.toThrow(/Invalid bottle size/);
  });

  it("correct_bottle is still SECURITY INVOKER", async () => {
    const r = await db.query<{ prosecdef: boolean }>(
      `select prosecdef from pg_proc where proname = 'correct_bottle'`,
    );
    expect(r.rows[0]!.prosecdef).toBe(false);
  });

  it("re-running 017 is harmless", async () => {
    await expect(db.exec(M017)).resolves.toBeTruthy();
    const r = await db.query<{ n: number }>(`
      select count(*)::int as n from pg_constraint
      where conname in ('acquisition_items_bottle_size_canonical', 'bottles_bottle_size_canonical')`);
    expect(r.rows[0]!.n).toBe(2);
  });
});

describe("017 never drops a constraint it does not recognise", () => {
  it("an UNEXPECTED bottle_size-only CHECK aborts the migration, untouched", async () => {
    const { db } = await freshDb();
    await db.exec(
      `alter table bottles add constraint someone_elses_rule check (length(bottle_size) < 20)`,
    );
    await expect(db.exec(M017)).rejects.toThrow(/refusing to drop/);
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint where conname = 'someone_elses_rule'`,
    );
    expect(r.rows[0]!.n).toBe(1);
  }, 90_000);

  it("a MULTI-column CHECK that mentions bottle_size is left alone", async () => {
    const { db } = await freshDb();
    await db.exec(`alter table acquisition_items
      add constraint mixed_rule check (bottle_size <> '' or quantity > 0)`);
    await db.exec(M017);
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint where conname = 'mixed_rule'`,
    );
    expect(r.rows[0]!.n).toBe(1);
  }, 90_000);
});

describe("017 is additive and self-contained", () => {
  const executable = M017.split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  it("rebuilds no table and assumes no generated constraint name", () => {
    expect(executable).not.toMatch(/drop table|create table/i);
    expect(executable).not.toMatch(
      /bottles_bottle_size_check|acquisition_items_bottle_size_check/,
    );
  });
  it("identifies constraints by structure", () => {
    expect(executable).toMatch(/conkey = array\[col\]/);
    expect(executable).toMatch(/contype = 'c'/);
  });
});
