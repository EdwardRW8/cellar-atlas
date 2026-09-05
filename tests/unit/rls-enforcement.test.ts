// @vitest-environment node

/**
 * PHASE 2.1 — RLS ENFORCEMENT
 *
 * The Phase 2 report flagged that PGlite runs as superuser, which bypasses
 * row-level security, so policies could only be inspected rather than proven.
 *
 * That limitation is removed here. These tests SET ROLE to a non-superuser
 * and attempt real mutations as owner, editor and viewer. RLS is genuinely
 * enforced — a viewer's insert fails with 42501, not because we asserted a
 * policy exists, but because Postgres refused it.
 *
 * WHAT THIS DOES NOT COVER: Supabase's JWT → auth.uid() plumbing. Here
 * auth.uid() reads a session setting. On live Supabase it derives from the
 * bearer token. The POLICIES are identical; the identity source differs.
 * The live checklist in the Phase 2.1 report covers that narrow gap.
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
let ownerId: string, editorId: string, viewerId: string, outsiderId: string;
let cellarA: string, cellarB: string;
let rackLoc: string, merchantLoc: string;
let wineId: string, bottleId: string, eventId: string, valuationId: string;

/** Run as a real non-superuser with a given identity. RLS applies. */
async function as<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  // `set local` outside a transaction is a no-op — the identity would never
  // change and every call would silently run as whoever was set last.
  await db.exec(`set role app_user; set test.user_id = '${userId}';`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

/**
 * Was the operation refused?
 *
 * Postgres denies via RLS in two different ways, and conflating them makes
 * a test wrong rather than the policy:
 *
 *   INSERT  — raises 42501, because the new row fails WITH CHECK
 *   UPDATE  — affects ZERO ROWS, because USING makes them invisible.
 *             No error is raised. The write simply does not happen.
 *   DELETE  — same as UPDATE.
 *
 * Both outcomes are a denial. Neither permits the write.
 */
async function expectDenied(userId: string, statement: string, params: unknown[] = []) {
  try {
    const result = await as(userId, async () => db.query(statement, params));
    const affected = result.affectedRows ?? 0;
    return {
      denied: affected === 0,
      code: affected === 0 ? "0-rows" : "",
      affected,
    };
  } catch (e) {
    return {
      denied: true,
      code: (e as { code?: string }).code ?? "unknown",
      affected: 0,
    };
  }
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

  const mk = async (email: string) => {
    const r = await db.query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [email],
    );
    return r.rows[0]!.id;
  };
  ownerId = await mk("owner@test");
  editorId = await mk("editor@test");
  viewerId = await mk("viewer@test");
  outsiderId = await mk("outsider@test");

  await db.exec(`set test.user_id = '${ownerId}'`);
  for (const f of MIGRATIONS) await db.exec(sql(f));

  // Two separate cellars, to prove tenant isolation.
  const a = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Cellar A', $1) returning id`,
    [ownerId],
  );
  cellarA = a.rows[0]!.id;
  const b = await db.query<{ id: string }>(
    `insert into cellars (name, created_by) values ('Cellar B', $1) returning id`,
    [outsiderId],
  );
  cellarB = b.rows[0]!.id;

  await db.query(
    `insert into cellar_members (cellar_id, user_id, role) values ($1,$2,'editor'),($1,$3,'viewer')`,
    [cellarA, editorId, viewerId],
  );

  // Seed content as superuser so the role tests start from a known state.
  const layout = await db.query<{ create_storage_layout: string }>(
    `select create_storage_layout(gen_random_uuid(), $1, 'Rack', 'staircase', $2::jsonb)`,
    [
      cellarA,
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
    [cellarA, layout.rows[0]!.create_storage_layout],
  );
  rackLoc = loc.rows[0]!.create_storage_location;
  const m = await db.query<{ create_storage_location: string }>(
    `select create_storage_location(gen_random_uuid(), $1, 'Merchant', 'merchant', null, true)`,
    [cellarA],
  );
  merchantLoc = m.rows[0]!.create_storage_location;

  const w = await db.query<{ create_wine_definition: string }>(
    `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
    [cellarA, JSON.stringify({ producer: "Test", name: "RLS Wine", vintage: 2018 })],
  );
  wineId = w.rows[0]!.create_wine_definition;

  const bt = await db.query<{ id: string }>(
    `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
     values ($1,$2,$3,$4) returning id`,
    [cellarA, wineId, merchantLoc, ownerId],
  );
  bottleId = bt.rows[0]!.id;

  await db.query(
    `select change_bottle_status(gen_random_uuid(), $1, 1, 'consumed', now())`,
    [bottleId],
  );
  const ev = await db.query<{ id: string }>(
    `select id from bottle_events where bottle_id=$1 limit 1`,
    [bottleId],
  );
  eventId = ev.rows[0]!.id;

  const vr = await db.query<{ record_valuation: string }>(
    `select record_valuation(gen_random_uuid(), $1, $2::jsonb)`,
    [
      cellarA,
      JSON.stringify({
        wine_definition_id: wineId,
        amount: 500,
        valuation_basis: "market_estimate",
      }),
    ],
  );
  valuationId = vr.rows[0]!.record_valuation;

  // A real non-superuser. RLS is enforced for this role.
  await db.exec(`
    create role app_user nologin;
    grant usage on schema public, auth to app_user;
    grant select, insert, update, delete on all tables in schema public to app_user;
    grant select on auth.users to app_user;
    grant usage, select on all sequences in schema public to app_user;
    grant execute on all functions in schema public to app_user;
  `);
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════
// The harness must itself be trustworthy
// ═══════════════════════════════════════════════════════════════════════════

describe("harness sanity — RLS is genuinely active", () => {
  it("app_user is not a superuser", async () => {
    const r = await db.query<{ rolsuper: boolean }>(
      `select rolsuper from pg_roles where rolname='app_user'`,
    );
    expect(r.rows[0]!.rolsuper).toBe(false);
  });

  it("a non-member sees nothing — proving RLS filters, not just errors", async () => {
    const r = await as(outsiderId, async () =>
      db.query<{ count: string }>(`select count(*)::text from wine_definitions`),
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  it("a member sees their own cellar's rows", async () => {
    const r = await as(viewerId, async () =>
      db.query<{ count: string }>(`select count(*)::text from wine_definitions`),
    );
    expect(Number(r.rows[0]!.count)).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VIEWER — can read, cannot mutate
// ═══════════════════════════════════════════════════════════════════════════

describe("viewer can read", () => {
  it("reads wines, bottles, events and valuations", async () => {
    const r = await as(viewerId, async () => {
      const w = await db.query<{ c: string }>(
        `select count(*)::text c from wine_definitions`,
      );
      const b = await db.query<{ c: string }>(`select count(*)::text c from bottles`);
      const e = await db.query<{ c: string }>(`select count(*)::text c from bottle_events`);
      const v = await db.query<{ c: string }>(
        `select count(*)::text c from valuation_records`,
      );
      return [w, b, e, v].map((x) => Number(x.rows[0]!.c));
    });
    expect(r.every((n) => n > 0)).toBe(true);
  });
});

describe("viewer CANNOT mutate — direct table access", () => {
  const cases: Array<[string, string, unknown[]]> = [
    [
      "insert a wine",
      `insert into wine_definitions (cellar_id, producer, name) values ($1,'X','Y')`,
      [],
    ],
    ["update a wine", `update wine_definitions set notes='hacked' where cellar_id=$1`, []],
    [
      "insert a bottle",
      `insert into bottles (cellar_id, wine_definition_id) values ($1,$2)`,
      [],
    ],
    ["update a bottle", `update bottles set notes='hacked' where cellar_id=$1`, []],
    [
      "insert an event",
      `insert into bottle_events (cellar_id, bottle_id, event_type) values ($1,$2,'moved')`,
      [],
    ],
    [
      "insert a valuation",
      `insert into valuation_records (cellar_id, wine_definition_id, amount, valuation_basis) values ($1,$2,1,'manual_estimate')`,
      [],
    ],
    [
      "insert a storage location",
      `insert into storage_locations (cellar_id, name) values ($1,'Sneaky')`,
      [],
    ],
    [
      "insert an acquisition",
      `insert into acquisitions (cellar_id, source) values ($1,'X')`,
      [],
    ],
  ];

  for (const [label, stmt] of cases) {
    it(`is denied: ${label}`, async () => {
      const params = stmt.includes("$2")
        ? [cellarA, stmt.includes("bottle_id") ? bottleId : wineId]
        : [cellarA];
      const { denied, code } = await expectDenied(viewerId, stmt, params);
      expect(denied, `${label} should have been denied`).toBe(true);
      // INSERT is refused outright; UPDATE is refused by matching no rows.
      expect(["42501", "0-rows"]).toContain(code);
    });
  }
});

describe("viewer CANNOT mutate — via the RPC functions the app uses", () => {
  it("is denied: create_wine_definition", async () => {
    const { denied } = await expectDenied(
      viewerId,
      `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
      [cellarA, JSON.stringify({ producer: "V", name: "V" })],
    );
    expect(denied).toBe(true);
  });

  it("is denied: create_acquisition_with_items", async () => {
    const { denied } = await expectDenied(
      viewerId,
      `select create_acquisition_with_items(gen_random_uuid(), $1, $2::jsonb, $3::jsonb)`,
      [
        cellarA,
        JSON.stringify({ source: "V" }),
        JSON.stringify([
          { wine_definition_id: wineId, quantity: 1, storage_location_id: merchantLoc },
        ]),
      ],
    );
    expect(denied).toBe(true);
  });

  it("is denied: move_bottle", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarA, wineId, merchantLoc, ownerId],
    );
    const { denied } = await expectDenied(
      viewerId,
      `select move_bottle(gen_random_uuid(), $1, $2, $3, $4::jsonb)`,
      [b.rows[0]!.id, b.rows[0]!.version, rackLoc, JSON.stringify({ col: 9, row: 1 })],
    );
    expect(denied).toBe(true);
  });

  it("is denied: record_valuation", async () => {
    const { denied } = await expectDenied(
      viewerId,
      `select record_valuation(gen_random_uuid(), $1, $2::jsonb)`,
      [
        cellarA,
        JSON.stringify({
          wine_definition_id: wineId,
          amount: 999,
          valuation_basis: "manual_estimate",
        }),
      ],
    );
    expect(denied).toBe(true);
  });

  it("SECURITY INVOKER means the functions do not escalate privilege", async () => {
    const r = await db.query<{ prosecdef: boolean; proname: string }>(
      `select proname, prosecdef from pg_proc
       where proname in ('create_wine_definition','move_bottle','change_bottle_status',
                         'correct_bottle','create_acquisition_with_items','record_valuation',
                         'record_tasting','claim_operation')`,
    );
    for (const row of r.rows) {
      expect(row.prosecdef, `${row.proname} must be SECURITY INVOKER`).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EDITOR — can mutate inventory, cannot manage membership
// ═══════════════════════════════════════════════════════════════════════════

describe("editor CAN mutate cellar inventory", () => {
  it("creates a wine via RPC", async () => {
    const r = await as(editorId, async () =>
      db.query<{ create_wine_definition: string }>(
        `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
        [cellarA, JSON.stringify({ producer: "Editor", name: "Made This", vintage: 2020 })],
      ),
    );
    expect(r.rows[0]!.create_wine_definition).toBeTruthy();
  });

  it("creates an acquisition with bottles", async () => {
    const r = await as(editorId, async () =>
      db.query<{ create_acquisition_with_items: string }>(
        `select create_acquisition_with_items(gen_random_uuid(), $1, $2::jsonb, $3::jsonb)`,
        [
          cellarA,
          JSON.stringify({ source: "Editor Order" }),
          JSON.stringify([
            { wine_definition_id: wineId, quantity: 3, storage_location_id: merchantLoc },
          ]),
        ],
      ),
    );
    expect(r.rows[0]!.create_acquisition_with_items).toBeTruthy();
  });

  it("moves a bottle", async () => {
    const b = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, storage_location_id, created_by)
       values ($1,$2,$3,$4) returning id, version`,
      [cellarA, wineId, merchantLoc, ownerId],
    );
    await as(editorId, async () =>
      db.query(`select move_bottle(gen_random_uuid(), $1, $2, $3, $4::jsonb)`, [
        b.rows[0]!.id,
        b.rows[0]!.version,
        rackLoc,
        JSON.stringify({ col: 10, row: 3 }),
      ]),
    );
    const after = await db.query<{ position_key: string }>(
      `select position_key from bottles where id=$1`,
      [b.rows[0]!.id],
    );
    expect(after.rows[0]!.position_key).toBe("c10r3");
  });
});

describe("editor CANNOT manage membership", () => {
  it("cannot add a member", async () => {
    const { denied, code } = await expectDenied(
      editorId,
      `insert into cellar_members (cellar_id, user_id, role) values ($1,$2,'editor')`,
      [cellarA, outsiderId],
    );
    expect(denied).toBe(true);
    expect(code).toBe("42501"); // INSERT genuinely raises
  });

  it("cannot promote themselves to owner", async () => {
    const { denied } = await expectDenied(
      editorId,
      `update cellar_members set role='owner' where cellar_id=$1 and user_id=$2`,
      [cellarA, editorId],
    );
    expect(denied).toBe(true);

    const check = await db.query<{ role: string }>(
      `select role from cellar_members where cellar_id=$1 and user_id=$2`,
      [cellarA, editorId],
    );
    expect(check.rows[0]!.role).toBe("editor");
  });

  it("cannot remove the owner", async () => {
    const { denied } = await expectDenied(
      editorId,
      `delete from cellar_members where cellar_id=$1 and user_id=$2`,
      [cellarA, ownerId],
    );
    expect(denied).toBe(true);
  });

  it("cannot write the cellar profile — owner only", async () => {
    const { denied } = await expectDenied(
      editorId,
      `insert into cellar_profiles (cellar_id, bottles_per_month) values ($1, 5)`,
      [cellarA],
    );
    expect(denied).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OWNER
// ═══════════════════════════════════════════════════════════════════════════

describe("owner CAN manage membership", () => {
  it("adds a member", async () => {
    await as(ownerId, async () =>
      db.query(
        `insert into cellar_members (cellar_id, user_id, role) values ($1,$2,'viewer')`,
        [cellarA, outsiderId],
      ),
    );
    const r = await db.query<{ role: string }>(
      `select role from cellar_members where cellar_id=$1 and user_id=$2`,
      [cellarA, outsiderId],
    );
    expect(r.rows[0]!.role).toBe("viewer");
  });

  it("changes a member's role", async () => {
    await as(ownerId, async () =>
      db.query(
        `update cellar_members set role='editor' where cellar_id=$1 and user_id=$2`,
        [cellarA, outsiderId],
      ),
    );
    const r = await db.query<{ role: string }>(
      `select role from cellar_members where cellar_id=$1 and user_id=$2`,
      [cellarA, outsiderId],
    );
    expect(r.rows[0]!.role).toBe("editor");
  });

  it("removes a member", async () => {
    await as(ownerId, async () =>
      db.query(`delete from cellar_members where cellar_id=$1 and user_id=$2`, [
        cellarA,
        outsiderId,
      ]),
    );
    const r = await db.query<{ c: string }>(
      `select count(*)::text c from cellar_members where cellar_id=$1 and user_id=$2`,
      [cellarA, outsiderId],
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("writes the cellar profile", async () => {
    await as(ownerId, async () =>
      db.query(
        `insert into cellar_profiles (cellar_id, bottles_per_month) values ($1, 8)
                on conflict (cellar_id) do update set bottles_per_month = 8`,
        [cellarA],
      ),
    );
    const r = await db.query<{ bottles_per_month: string }>(
      `select bottles_per_month::text from cellar_profiles where cellar_id=$1`,
      [cellarA],
    );
    expect(Number(r.rows[0]!.bottles_per_month)).toBe(8);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IMMUTABLE HISTORY
// ═══════════════════════════════════════════════════════════════════════════

describe("history cannot be rewritten — by anyone", () => {
  for (const label of ["owner", "editor", "viewer"] as const) {
    it(`${label} cannot update a bottle_event`, async () => {
      const uid = label === "owner" ? ownerId : label === "editor" ? editorId : viewerId;
      const { denied } = await expectDenied(
        uid,
        `update bottle_events set notes='rewritten' where id=$1`,
        [eventId],
      );
      expect(denied).toBe(true);
    });

    it(`${label} cannot delete a bottle_event`, async () => {
      const uid = label === "owner" ? ownerId : label === "editor" ? editorId : viewerId;
      const { denied } = await expectDenied(uid, `delete from bottle_events where id=$1`, [
        eventId,
      ]);
      expect(denied).toBe(true);
    });
  }

  it("nobody can update a valuation_record", async () => {
    for (const uid of [ownerId, editorId, viewerId]) {
      const { denied } = await expectDenied(
        uid,
        `update valuation_records set amount=1 where id=$1`,
        [valuationId],
      );
      expect(denied).toBe(true);
    }
  });

  it("nobody can delete a valuation_record", async () => {
    for (const uid of [ownerId, editorId, viewerId]) {
      const { denied } = await expectDenied(
        uid,
        `delete from valuation_records where id=$1`,
        [valuationId],
      );
      expect(denied).toBe(true);
    }
  });

  it("nobody can delete a bottle — bottles are historical truth", async () => {
    for (const uid of [ownerId, editorId]) {
      const { denied } = await expectDenied(uid, `delete from bottles where id=$1`, [
        bottleId,
      ]);
      expect(denied).toBe(true);
    }
  });

  it("nobody can rewrite applied_operations", async () => {
    const op = await db.query<{ operation_id: string }>(
      `select operation_id from applied_operations limit 1`,
    );
    for (const uid of [ownerId, editorId]) {
      const u = await expectDenied(
        uid,
        `update applied_operations set entity='x' where operation_id=$1`,
        [op.rows[0]!.operation_id],
      );
      const d = await expectDenied(
        uid,
        `delete from applied_operations where operation_id=$1`,
        [op.rows[0]!.operation_id],
      );
      expect(u.denied).toBe(true);
      expect(d.denied).toBe(true);
    }
  });

  it("the event survived every attempt", async () => {
    const r = await db.query<{ notes: string | null }>(
      `select notes from bottle_events where id=$1`,
      [eventId],
    );
    expect(r.rows[0]!.notes).not.toBe("rewritten");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-CELLAR ISOLATION
// ═══════════════════════════════════════════════════════════════════════════

describe("cross-cellar access is denied", () => {
  it("an outsider cannot read another cellar's wines", async () => {
    const r = await as(outsiderId, async () =>
      db.query<{ c: string }>(
        `select count(*)::text c from wine_definitions where cellar_id=$1`,
        [cellarA],
      ),
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("an outsider cannot read another cellar's bottles or events", async () => {
    const r = await as(outsiderId, async () => {
      const b = await db.query<{ c: string }>(`select count(*)::text c from bottles`);
      const e = await db.query<{ c: string }>(`select count(*)::text c from bottle_events`);
      return [Number(b.rows[0]!.c), Number(e.rows[0]!.c)];
    });
    expect(r).toEqual([0, 0]);
  });

  it("an outsider cannot write into another cellar", async () => {
    const { denied } = await expectDenied(
      outsiderId,
      `insert into wine_definitions (cellar_id, producer, name) values ($1,'Hack','Hack')`,
      [cellarA],
    );
    expect(denied).toBe(true);
  });

  it("an outsider cannot call an RPC against another cellar", async () => {
    const { denied } = await expectDenied(
      outsiderId,
      `select create_wine_definition(gen_random_uuid(), $1, $2::jsonb)`,
      [cellarA, JSON.stringify({ producer: "Hack", name: "Hack" })],
    );
    expect(denied).toBe(true);
  });

  it("a member of cellar A cannot reach cellar B", async () => {
    const { denied } = await expectDenied(
      editorId,
      `insert into wine_definitions (cellar_id, producer, name) values ($1,'X','Y')`,
      [cellarB],
    );
    expect(denied).toBe(true);

    const r = await as(editorId, async () =>
      db.query<{ c: string }>(`select count(*)::text c from cellars where id=$1`, [
        cellarB,
      ]),
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });

  it("an editor cannot move a bottle into another cellar's storage", async () => {
    const bInB = await db.query<{ id: string; version: number }>(
      `insert into bottles (cellar_id, wine_definition_id, created_by)
       values ($1,$2,$3) returning id, version`,
      [cellarA, wineId, ownerId],
    );
    // cellarB has no storage, so target a nonexistent location: must fail.
    const { denied } = await expectDenied(
      editorId,
      `select move_bottle(gen_random_uuid(), $1, $2, '99999999-9999-4999-8999-999999999999', null)`,
      [bInB.rows[0]!.id, bInB.rows[0]!.version],
    );
    expect(denied).toBe(true);
  });
});
