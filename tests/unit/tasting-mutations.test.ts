// @vitest-environment node

/**
 * PHASE 9 — TASTING MUTATIONS & CELLAR HISTORY
 *
 * Run against a real Postgres engine. The guarantee that matters most:
 * editing or deleting a TASTING must never alter the BOTTLE_EVENT that
 * recorded it. A tasting note is subjective and correctable; the fact that
 * the tasting happened is history and is not.
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
  "014_storage_mutations.sql",
  "015_tasting_mutations.sql",
];

let db: PGlite;
let cellarId: string;
let userId: string;
let wineId: string;
let bottleId: string;

async function versionOf(table: string, id: string): Promise<number> {
  const r = await db.query<{ version: number }>(
    `select version from ${table} where id = $1`,
    [id],
  );
  return r.rows[0]!.version;
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
    `insert into auth.users (email) values ('taster@test') returning id`,
  );
  userId = u.rows[0]!.id;
  await db.exec(`set test.user_id = '${userId}'`);
  for (const f of MIGRATIONS) await db.exec(sql(f));

  const c = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Tasting Test', $1) returning id`,
    [userId],
  );
  cellarId = c.rows[0]!.id;

  const w = await db.query<{ create_wine_definition: string }>(
    `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
    [cellarId, JSON.stringify({ producer: "Test", name: "Tasted Wine", vintage: 2018 })],
  );
  wineId = w.rows[0]!.create_wine_definition;

  const b = await db.query<{ id: string }>(
    `insert into bottles (cellar_id, wine_definition_id, created_by)
     values ($1,$2,$3) returning id`,
    [cellarId, wineId, userId],
  );
  bottleId = b.rows[0]!.id;
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════
// THE CRITICAL SEPARATION
// ═══════════════════════════════════════════════════════════════════════════

describe("editing a tasting NEVER alters its bottle event", () => {
  let tastingId: string;
  let eventBefore: Record<string, unknown>;

  beforeAll(async () => {
    const t = await db.query<{ record_tasting: string }>(
      `select record_tasting(gen_random_uuid(), $1, $2::jsonb)`,
      [
        cellarId,
        JSON.stringify({
          wine_definition_id: wineId,
          bottle_id: bottleId,
          rating: 3,
          notes: "Original note",
        }),
      ],
    );
    tastingId = t.rows[0]!.record_tasting;

    const e = await db.query<Record<string, unknown>>(
      `select * from bottle_events
       where bottle_id = $1 and event_type = 'tasting_recorded'`,
      [bottleId],
    );
    eventBefore = e.rows[0]!;
    expect(eventBefore, "a tasting_recorded event should exist").toBeTruthy();
  });

  it("the edit succeeds", async () => {
    await db.query(`select update_tasting_record(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      tastingId,
      await versionOf("tasting_records", tastingId),
      JSON.stringify({ rating: 5, notes: "Corrected note" }),
    ]);

    const r = await db.query<{ rating: number; notes: string }>(
      `select rating, notes from tasting_records where id = $1`,
      [tastingId],
    );
    expect(r.rows[0]).toMatchObject({ rating: 5, notes: "Corrected note" });
  });

  it("THE BOTTLE EVENT IS BYTE IDENTICAL afterwards", async () => {
    const e = await db.query<Record<string, unknown>>(
      `select * from bottle_events
       where bottle_id = $1 and event_type = 'tasting_recorded'`,
      [bottleId],
    );
    expect(e.rows[0]).toEqual(eventBefore);
  });

  it("no ADDITIONAL event is created by the edit", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from bottle_events
       where bottle_id = $1 and event_type = 'tasting_recorded'`,
      [bottleId],
    );
    expect(Number(r.rows[0]!.c)).toBe(1);
  });

  it("soft deleting the tasting also leaves the event untouched", async () => {
    await db.query(
      `select soft_delete_tasting_record(gen_random_uuid(), $1, $2, 'entered twice')`,
      [tastingId, await versionOf("tasting_records", tastingId)],
    );

    const e = await db.query<Record<string, unknown>>(
      `select * from bottle_events
       where bottle_id = $1 and event_type = 'tasting_recorded'`,
      [bottleId],
    );
    expect(e.rows[0]).toEqual(eventBefore);
  });

  it("the deleted tasting row SURVIVES, so the event keeps a valid target", async () => {
    const r = await db.query<{ deleted_at: string | null; delete_reason: string }>(
      `select deleted_at, delete_reason from tasting_records where id = $1`,
      [tastingId],
    );
    expect(r.rows[0]!.deleted_at).not.toBeNull();
    expect(r.rows[0]!.delete_reason).toBe("entered twice");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE SEMANTICS
// ═══════════════════════════════════════════════════════════════════════════

describe("update semantics", () => {
  async function freshTasting(over: Record<string, unknown> = {}) {
    const t = await db.query<{ record_tasting: string }>(
      `select record_tasting(gen_random_uuid(), $1, $2::jsonb)`,
      [
        cellarId,
        JSON.stringify({
          wine_definition_id: wineId,
          rating: 3,
          notes: "Note",
          ...over,
        }),
      ],
    );
    return t.rows[0]!.record_tasting;
  }

  it("updates only the fields supplied", async () => {
    const id = await freshTasting();
    await db.query(`select update_tasting_record(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      id,
      await versionOf("tasting_records", id),
      JSON.stringify({ rating: 5 }),
    ]);

    const r = await db.query<{ rating: number; notes: string }>(
      `select rating, notes from tasting_records where id = $1`,
      [id],
    );
    expect(r.rows[0]!.rating).toBe(5);
    expect(r.rows[0]!.notes).toBe("Note"); // untouched
  });

  it("distinguishes 'set to null' from 'leave alone'", async () => {
    const id = await freshTasting();
    await db.query(`select update_tasting_record(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      id,
      await versionOf("tasting_records", id),
      JSON.stringify({ rating: null }),
    ]);

    const r = await db.query<{ rating: number | null; notes: string }>(
      `select rating, notes from tasting_records where id = $1`,
      [id],
    );
    expect(r.rows[0]!.rating).toBeNull();
    expect(r.rows[0]!.notes).toBe("Note");
  });

  it("rejects a rating outside 1..5 with a readable message", async () => {
    const id = await freshTasting();
    await expect(
      db.query(`select update_tasting_record(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        id,
        await versionOf("tasting_records", id),
        JSON.stringify({ rating: 9 }),
      ]),
    ).rejects.toThrow(/between 1 and 5/);
  });

  it("does NOT allow the wine to be changed", async () => {
    const id = await freshTasting();
    const other = await db.query<{ create_wine_definition: string }>(
      `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
      [cellarId, JSON.stringify({ producer: "Other", name: "Other Wine" })],
    );

    await db.query(`select update_tasting_record(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      id,
      await versionOf("tasting_records", id),
      JSON.stringify({ wine_definition_id: other.rows[0]!.create_wine_definition }),
    ]);

    const r = await db.query<{ wine_definition_id: string }>(
      `select wine_definition_id from tasting_records where id = $1`,
      [id],
    );
    expect(r.rows[0]!.wine_definition_id).toBe(wineId);
  });

  it("rejects a stale version", async () => {
    const id = await freshTasting();
    const current = await versionOf("tasting_records", id);
    await expect(
      db.query(`select update_tasting_record(gen_random_uuid(), $1, $2, $3::jsonb)`, [
        id,
        current - 1,
        JSON.stringify({ rating: 4 }),
      ]),
    ).rejects.toThrow(/version conflict/);
  });

  it("replaying an operation applies once", async () => {
    const id = await freshTasting();
    const op = "eeeeeeee-0000-4000-8000-000000000001";
    const v = await versionOf("tasting_records", id);

    await db.query(`select update_tasting_record($1,$2,$3,$4::jsonb)`, [
      op,
      id,
      v,
      JSON.stringify({ rating: 5 }),
    ]);
    await db.query(`select update_tasting_record($1,$2,$3,$4::jsonb)`, [
      op,
      id,
      v,
      JSON.stringify({ rating: 5 }),
    ]);

    expect(await versionOf("tasting_records", id)).toBe(v + 1);
  });

  it("refuses to update a missing tasting", async () => {
    await expect(
      db.query(`select update_tasting_record(gen_random_uuid(), $1, 1, '{}'::jsonb)`, [
        "99999999-9999-4999-8999-999999999999",
      ]),
    ).rejects.toThrow(/not found/);
  });
});

describe("soft delete semantics", () => {
  it("requires a reason", async () => {
    const t = await db.query<{ record_tasting: string }>(
      `select record_tasting(gen_random_uuid(), $1, $2::jsonb)`,
      [cellarId, JSON.stringify({ wine_definition_id: wineId, rating: 3 })],
    );
    const id = t.rows[0]!.record_tasting;

    await expect(
      db.query(`select soft_delete_tasting_record(gen_random_uuid(), $1, $2, '')`, [
        id,
        await versionOf("tasting_records", id),
      ]),
    ).rejects.toThrow(/requires a reason/);
  });

  it("refuses to delete twice", async () => {
    const t = await db.query<{ record_tasting: string }>(
      `select record_tasting(gen_random_uuid(), $1, $2::jsonb)`,
      [cellarId, JSON.stringify({ wine_definition_id: wineId, rating: 3 })],
    );
    const id = t.rows[0]!.record_tasting;

    await db.query(
      `select soft_delete_tasting_record(gen_random_uuid(), $1, $2, 'wrong')`,
      [id, await versionOf("tasting_records", id)],
    );

    await expect(
      db.query(`select soft_delete_tasting_record(gen_random_uuid(), $1, $2, 'again')`, [
        id,
        await versionOf("tasting_records", id),
      ]),
    ).rejects.toThrow(/not found or already removed/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TASTED ELSEWHERE
// ═══════════════════════════════════════════════════════════════════════════

describe("a tasting for a wine not in the cellar", () => {
  it("records with a NULL bottle_id", async () => {
    const t = await db.query<{ record_tasting: string }>(
      `select record_tasting(gen_random_uuid(), $1, $2::jsonb)`,
      [
        cellarId,
        JSON.stringify({
          wine_definition_id: wineId,
          bottle_id: null,
          rating: 4,
          notes: "At a restaurant",
          context: "Dinner out",
        }),
      ],
    );

    const r = await db.query<{ bottle_id: string | null; context: string }>(
      `select bottle_id, context from tasting_records where id = $1`,
      [t.rows[0]!.record_tasting],
    );
    expect(r.rows[0]!.bottle_id).toBeNull();
    expect(r.rows[0]!.context).toBe("Dinner out");
  });

  it("creates NO bottle event, since no bottle was involved", async () => {
    const before = await db.query<{ c: string }>(
      `select count(*)::text c from bottle_events where cellar_id = $1`,
      [cellarId],
    );

    await db.query(`select record_tasting(gen_random_uuid(), $1, $2::jsonb)`, [
      cellarId,
      JSON.stringify({
        wine_definition_id: wineId,
        bottle_id: null,
        rating: 5,
      }),
    ]);

    const after = await db.query<{ c: string }>(
      `select count(*)::text c from bottle_events where cellar_id = $1`,
      [cellarId],
    );
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  });

  it("can be edited like any other tasting", async () => {
    const t = await db.query<{ record_tasting: string }>(
      `select record_tasting(gen_random_uuid(), $1, $2::jsonb)`,
      [
        cellarId,
        JSON.stringify({
          wine_definition_id: wineId,
          bottle_id: null,
          rating: 2,
        }),
      ],
    );
    const id = t.rows[0]!.record_tasting;

    await db.query(`select update_tasting_record(gen_random_uuid(), $1, $2, $3::jsonb)`, [
      id,
      await versionOf("tasting_records", id),
      JSON.stringify({ rating: 4 }),
    ]);

    const r = await db.query<{ rating: number }>(
      `select rating from tasting_records where id = $1`,
      [id],
    );
    expect(r.rows[0]!.rating).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CELLAR HISTORY
// ═══════════════════════════════════════════════════════════════════════════

describe("cellar-wide history", () => {
  it("returns events newest first with wine details", async () => {
    const r = await db.query<{ event_type: string; wine_name: string }>(
      `select * from cellar_history($1, 50)`,
      [cellarId],
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0]!.wine_name).toBe("Tasted Wine");
  });

  it("respects the limit", async () => {
    const r = await db.query<{ id: string }>(`select * from cellar_history($1, 1)`, [
      cellarId,
    ]);
    expect(r.rows).toHaveLength(1);
  });

  it("caps an absurd limit rather than returning everything", async () => {
    const r = await db.query<{ id: string }>(`select * from cellar_history($1, 100000)`, [
      cellarId,
    ]);
    expect(r.rows.length).toBeLessThanOrEqual(200);
  });

  it("filters by event type", async () => {
    const r = await db.query<{ event_type: string }>(
      `select * from cellar_history($1, 50, null, array['tasting_recorded'])`,
      [cellarId],
    );
    expect(r.rows.every((x) => x.event_type === "tasting_recorded")).toBe(true);
  });

  it("paginates with `before`", async () => {
    const first = await db.query<{ occurred_at: string }>(
      `select * from cellar_history($1, 1)`,
      [cellarId],
    );
    const next = await db.query<{ occurred_at: string }>(
      `select * from cellar_history($1, 50, $2)`,
      [cellarId, first.rows[0]!.occurred_at],
    );
    for (const row of next.rows) {
      expect(row.occurred_at < first.rows[0]!.occurred_at).toBe(true);
    }
  });

  it("returns nothing for another cellar", async () => {
    const other = await db.query<{ id: string }>(
      `insert into cellars (name, created_by) values ('Other', $1) returning id`,
      [userId],
    );
    const r = await db.query<{ id: string }>(`select * from cellar_history($1, 50)`, [
      other.rows[0]!.id,
    ]);
    expect(r.rows).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION HYGIENE
// ═══════════════════════════════════════════════════════════════════════════

describe("migration 015 hygiene", () => {
  it("all three functions are SECURITY INVOKER", async () => {
    const r = await db.query<{ proname: string; prosecdef: boolean }>(
      `select proname, prosecdef from pg_proc
       where pronamespace = 'public'::regnamespace
         and proname in ('update_tasting_record','soft_delete_tasting_record',
                         'cellar_history')`,
    );
    expect(r.rows).toHaveLength(3);
    expect(r.rows.every((x) => x.prosecdef === false)).toBe(true);
  });

  it("015 alters no existing table or policy", () => {
    const s = sql("015_tasting_mutations.sql");
    expect(s).not.toMatch(/alter table/i);
    expect(s).not.toMatch(/drop table/i);
    expect(s).not.toMatch(/drop policy/i);
  });

  it("015 adds no DELETE policy and no bottle_events write", () => {
    const s = sql("015_tasting_mutations.sql");
    expect(s).not.toMatch(/for delete/i);
    expect(s).not.toMatch(/insert\s+into\s+bottle_events/i);
    expect(s).not.toMatch(/update\s+bottle_events/i);
    expect(s).not.toMatch(/delete\s+from\s+bottle_events/i);
  });

  it("bottle_events still has no UPDATE or DELETE policy", async () => {
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from pg_policies
       where tablename = 'bottle_events' and cmd in ('UPDATE','DELETE')`,
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("RLS remains enabled on every table", async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_tables
       where schemaname='public' and rowsecurity = false`,
    );
    expect(r.rows).toEqual([]);
  });
});
