/**
 * WHAT GETS DUMPED, IN WHICH FILES, AND WHY THE SPLIT IS WHERE IT IS.
 *
 * Four files, and the division is not cosmetic:
 *
 *   roles.sql          pg_dumpall --roles-only
 *   schema-public.sql  the application's own DDL
 *   schema-auth.sql    Supabase's auth DDL, kept SEPARATE — see below
 *   data.sql           all row data, public AND auth, in ONE pg_dump run
 *
 * ── WHY DATA IS ONE FILE AND ONE RUN (consistency) ───────────────────────
 * Every `pg_dump` invocation takes its own repeatable-read snapshot. Two runs
 * are two snapshots, so dumping `public` and `auth` separately could capture
 * a bottle whose owning user is absent, or a cellar membership referencing a
 * user created after the first dump finished. Referential integrity between
 * `public` and `auth` is exactly what a restore depends on, so the data dump
 * is a single invocation covering both schemas: one transaction, one
 * snapshot, internally consistent by construction.
 *
 * DDL has no such dependency between the two schemas at restore time, which
 * is why the schema dump CAN be split — and must be, for the reason below.
 *
 * ── WHY auth DDL IS SEPARATE (Supabase restore compatibility) ────────────
 * A new Supabase project creates the `auth` schema itself, from GoTrue's own
 * migrations, before you can restore anything into it. Replaying our
 * `auth` DDL over that conflicts object by object, and the errors are
 * indistinguishable from real failures — so an operator either stops on noise
 * or, worse, learns to ignore errors during a restore.
 *
 * Separating it means the documented procedure can be exact: apply
 * `schema-public.sql`, do NOT replay `schema-auth.sql`, and keep the latter
 * as the reference for diffing what the platform created against what was
 * captured. See docs/disaster-recovery.md.
 *
 * ── WHY auth IS DUMPED AT ALL ─────────────────────────────────────────────
 * Without `auth` data, a restored database holds a collection whose every
 * `created_by` and cellar membership points at a user who no longer exists.
 * That is not a recovered application, and an outage is the wrong time to
 * find out. Because it IS included, the data dump contains email addresses
 * and password hashes — the reason encryption is not optional anywhere here.
 */

/**
 * Schemas carried in the dumps.
 *
 * Supabase's other internal schemas (`storage`, `realtime`, `vault`, …) are
 * platform-managed and are not restorable from a dump into a new project, so
 * dumping them would add volume and a false sense of completeness. If the app
 * ever uses Supabase Storage, `storage` belongs here and
 * docs/disaster-recovery.md records that.
 */
export const BACKUP_SCHEMAS = ["public", "auth"];

/** Schemas whose DDL is dumped to its own file, in this order. */
export const SCHEMA_DUMP_ORDER = ["public", "auth"];

/**
 * The commands of one backup.
 *
 * NOTE WHAT IS ABSENT: no connection string, no `-d`, no password. The target
 * travels in the child process environment (see lib/connection.mjs), so argv
 * is safe to print, safe to log, and safe to assert on in a test.
 *
 * @returns {{name: string, file: string, command: string, args: string[], kind: string}[]}
 */
export function buildDumpPlan(stem) {
  const plan = [
    {
      name: "roles",
      kind: "roles",
      file: `${stem}.roles.sql`,
      command: "pg_dumpall",
      // --no-role-passwords keeps role password hashes out of the dump. The
      // roles themselves are what a restore needs to know about; Supabase
      // manages their credentials, and END-USER passwords live in
      // auth.users, which the data dump carries.
      args: ["--roles-only", "--no-role-passwords"],
    },
  ];

  for (const schema of SCHEMA_DUMP_ORDER) {
    plan.push({
      name: `schema-${schema}`,
      kind: "schema",
      file: `${stem}.schema-${schema}.sql`,
      command: "pg_dump",
      args: [
        "--schema-only",
        "--schema",
        schema,
        // Survives a restore into a project whose default search_path or
        // quoting conventions differ.
        "--quote-all-identifiers",
      ],
    });
  }

  plan.push({
    name: "data",
    kind: "data",
    file: `${stem}.data.sql`,
    command: "pg_dump",
    args: [
      "--data-only",
      // ONE invocation for both schemas: one snapshot, referentially
      // consistent. Splitting these would break that guarantee.
      ...BACKUP_SCHEMAS.flatMap((s) => ["--schema", s]),
      "--quote-all-identifiers",
      // COPY rather than INSERT: far smaller, far faster to restore, and —
      // because COPY text format escapes newlines within fields — exactly one
      // line per row, which is what makes countDumpRows() below trustworthy.
      "--format=plain",
      // Without this, a data-only restore applies rows in an order that can
      // violate foreign keys. Requires elevated rights on the TARGET only.
      "--disable-triggers",
    ],
  });

  return plan;
}

/** Every file suffix one complete backup set must contain. */
export function expectedSuffixes() {
  return [
    ".roles.sql.age",
    ...SCHEMA_DUMP_ORDER.map((s) => `.schema-${s}.sql.age`),
    ".data.sql.age",
    ".manifest.json",
  ];
}

/**
 * COUNT THE ROWS THE DUMP ACTUALLY CONTAINS.
 *
 * This is the correction that matters most about the manifest. Counting rows
 * with a separate `SELECT count(*)` describes the LIVE database at the moment
 * of the query — a different snapshot from the dump, taken afterwards. Those
 * counts can legitimately differ from the dump's contents, so presenting them
 * as a property of the backup is wrong, and comparing a restore against them
 * would raise false alarms or hide real loss.
 *
 * These counts are derived from the dump bytes themselves, so they describe
 * the artefact. `pg_dump --format=plain --data-only` emits, per table:
 *
 *   COPY "public"."bottles" (...) FROM stdin;
 *   <one line per row, newlines inside values escaped as \\n>
 *   \\.
 *
 * so counting lines between the header and the terminator is exact.
 *
 * @param {string} dataSql Contents of the .data.sql dump.
 * @returns {Record<string, number>} `schema.table` → rows, from the dump.
 */
export function countDumpRows(dataSql) {
  const counts = {};
  const lines = dataSql.split("\n");
  let current = null;
  let n = 0;

  for (const line of lines) {
    if (current === null) {
      // COPY "schema"."table" (cols) FROM stdin;   (quoted or bare)
      const m = /^COPY\s+"?([^".\s]+)"?\."?([^".\s(]+)"?\s*(\([^)]*\))?\s*FROM stdin;/.exec(
        line,
      );
      if (m) {
        current = `${m[1]}.${m[2]}`;
        n = 0;
      }
      continue;
    }
    if (line === "\\.") {
      // Several COPY blocks for one table (never emitted by pg_dump, but
      // harmless to support) accumulate rather than overwrite.
      counts[current] = (counts[current] ?? 0) + n;
      current = null;
      continue;
    }
    n += 1;
  }

  if (current !== null) {
    // A truncated dump: the terminator never arrived. Refuse to report a
    // count that would look like a complete table.
    throw new Error(
      `The data dump is truncated: COPY block for ${current} has no terminator. ` +
        `The dump is incomplete and must not be kept.`,
    );
  }

  return counts;
}

/**
 * Tables whose row counts are OBSERVED against the live database.
 *
 * Kept only as a cross-check and recorded as observational. The authoritative
 * numbers are countDumpRows() above.
 */
export const MANIFEST_COUNT_QUERY = `
  SELECT 'public.wine_definitions' AS table_name, count(*) AS rows FROM public.wine_definitions
  UNION ALL SELECT 'public.bottles', count(*) FROM public.bottles
  UNION ALL SELECT 'public.acquisitions', count(*) FROM public.acquisitions
  UNION ALL SELECT 'public.acquisition_items', count(*) FROM public.acquisition_items
  UNION ALL SELECT 'public.bottle_events', count(*) FROM public.bottle_events
  UNION ALL SELECT 'public.valuation_records', count(*) FROM public.valuation_records
  UNION ALL SELECT 'public.tasting_records', count(*) FROM public.tasting_records
  UNION ALL SELECT 'public.storage_locations', count(*) FROM public.storage_locations
  UNION ALL SELECT 'public.cellars', count(*) FROM public.cellars
  UNION ALL SELECT 'public.cellar_members', count(*) FROM public.cellar_members
  UNION ALL SELECT 'auth.users', count(*) FROM auth.users
  ORDER BY table_name
`;

/**
 * Tables whose emptiness means the backup is not worth keeping.
 *
 * Deliberately short. A new cellar legitimately has no valuations and no
 * tastings, so those are not here; a database with no users and no cellars is
 * not this application's database.
 */
export const MUST_NOT_BE_EMPTY = ["auth.users", "public.cellars"];

/**
 * Judge the dump's OWN counts — never the observed ones.
 *
 * The failure this catches looks like success: `pg_dump` exits 0 having
 * dumped nothing, because RLS, a pooler quirk or the wrong database got in
 * the way. Checking the live database would not catch it; checking the
 * artefact does.
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkCounts(dumpCounts) {
  const problems = [];
  for (const table of MUST_NOT_BE_EMPTY) {
    if (!(table in dumpCounts)) {
      problems.push(`${table}: absent from the dump — no COPY block was emitted`);
    } else if (Number(dumpCounts[table]) === 0) {
      problems.push(`${table}: 0 rows in the dump — an empty or wrong database`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Compare the dump's counts against what was observed live.
 *
 * NOT a pass/fail gate. The two are different snapshots, taken moments apart,
 * and on a live database they are *expected* to differ occasionally. Recorded
 * so a large divergence is visible to a human, and so nobody mistakes the
 * observed numbers for a property of the backup.
 */
export function compareCounts(dumpCounts, observedCounts) {
  const differences = [];
  for (const [table, observed] of Object.entries(observedCounts)) {
    const dumped = dumpCounts[table];
    if (dumped === undefined) {
      differences.push({ table, dumped: null, observed, note: "not in dump" });
    } else if (Number(dumped) !== Number(observed)) {
      differences.push({ table, dumped, observed, note: "different snapshot" });
    }
  }
  return differences;
}
