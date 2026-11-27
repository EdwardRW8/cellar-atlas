/**
 * THE SEVEN AUDIT CORRECTIONS TO 12.3, AS BEHAVIOUR.
 *
 * Each `describe` below is one finding. These are separate from
 * backup-safety.test.ts deliberately: that file covers the original gate, and
 * keeping the corrections legible as corrections makes the next review of
 * this area possible.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { pgEnvFromUrl, isSecureSslmode } from "../../scripts/backup/lib/connection.mjs";
import {
  countDumpRows,
  checkCounts,
  compareCounts,
  buildDumpPlan,
  expectedSuffixes,
  SCHEMA_DUMP_ORDER,
} from "../../scripts/backup/lib/dump-plan.mjs";
import {
  planRetention,
  groupIntoSets,
  classifyObject,
  backupStem,
} from "../../scripts/backup/lib/retention.mjs";
import { verifyUploadedSet, pruneIsSafe } from "../../scripts/backup/lib/verify-upload.mjs";

const WORKFLOW = ".github/workflows/backup.yml";
const workflow = readFileSync(WORKFLOW, "utf8");
const workflowCode = workflow
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

const SUPABASE =
  "postgresql://postgres.abc:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres";

/* ══════════ 1. INSECURE sslmode IS REJECTED, NOT DOWNGRADED ══════════ */

describe("correction 1 — insecure sslmode values are rejected outright", () => {
  /**
   * `prefer` is the trap. It sounds cautious and it is not: it attempts TLS
   * and then SILENTLY falls back to plaintext if the server declines. The
   * dump contains the auth schema, so that fallback would stream every
   * password hash across the public internet with nothing in the log.
   */
  it.each(["disable", "allow", "prefer"])("refuses sslmode=%s on a remote host", (mode) => {
    expect(() => pgEnvFromUrl(`${SUPABASE}?sslmode=${mode}`)).toThrow(
      /unencrypted connection/i,
    );
    expect(() => pgEnvFromUrl(`${SUPABASE}?sslmode=${mode}`)).toThrow(/auth schema/i);
  });

  it("is case- and whitespace-insensitive, so no spelling slips through", () => {
    for (const mode of ["DISABLE", "Prefer", " allow "]) {
      expect(() =>
        pgEnvFromUrl(`${SUPABASE}?sslmode=${encodeURIComponent(mode)}`),
      ).toThrow();
    }
  });

  it("refuses an unrecognised mode rather than passing it to libpq", () => {
    expect(() => pgEnvFromUrl(`${SUPABASE}?sslmode=maybe`)).toThrow(
      /unrecognised sslmode/i,
    );
  });

  it("defaults to require when no mode is given", () => {
    expect(pgEnvFromUrl(SUPABASE).PGSSLMODE).toBe("require");
  });

  /** "Prefer verified TLS where supported" — verification needs a CA to check. */
  it("rises to verify-full when a CA certificate is configured", () => {
    const env = pgEnvFromUrl(SUPABASE, { caCertPath: "/etc/ssl/supabase-ca.crt" });
    expect(env.PGSSLMODE).toBe("verify-full");
    expect(env.PGSSLROOTCERT).toBe("/etc/ssl/supabase-ca.crt");
  });

  it("accepts verify-ca and verify-full only when there is something to verify against", () => {
    for (const mode of ["verify-ca", "verify-full"]) {
      expect(() => pgEnvFromUrl(`${SUPABASE}?sslmode=${mode}`)).toThrow(/CA certificate/i);
      expect(
        pgEnvFromUrl(`${SUPABASE}?sslmode=${mode}`, { caCertPath: "/ca.crt" }).PGSSLMODE,
      ).toBe(mode);
    }
  });

  /**
   * The loopback exemption exists so the integration test can run against a
   * disposable local Postgres. It can never apply to production, because a
   * Supabase pooler host is not a loopback address however the URL is written.
   */
  it("permits sslmode=disable ONLY for a loopback host", () => {
    expect(
      pgEnvFromUrl("postgresql://u:p@127.0.0.1:55432/postgres?sslmode=disable").PGSSLMODE,
    ).toBe("disable");
    expect(
      pgEnvFromUrl("postgresql://u:p@localhost:5432/postgres?sslmode=disable").PGSSLMODE,
    ).toBe("disable");
    // Anything resembling the real thing is still refused.
    for (const host of [
      "db.supabase.co",
      "aws-0-eu-west-2.pooler.supabase.com",
      "10.0.0.5",
    ]) {
      expect(() =>
        pgEnvFromUrl(`postgresql://u:p@${host}:5432/postgres?sslmode=disable`),
      ).toThrow();
    }
  });

  it("classifies which modes actually encrypt", () => {
    for (const m of ["require", "verify-ca", "verify-full"])
      expect(isSecureSslmode(m)).toBe(true);
    for (const m of ["disable", "allow", "prefer"]) expect(isSecureSslmode(m)).toBe(false);
  });
});

/* ════ 2. VERIFIED DUMP COUNTS vs OBSERVATIONAL LIVE COUNTS ════ */

describe("correction 2 — the manifest distinguishes the dump from the live database", () => {
  /**
   * `pg_dump --format=plain --data-only` emits one line per row and escapes
   * newlines inside values, so counting lines between the COPY header and
   * its terminator is exact — and, unlike a separate SELECT, it describes
   * THIS dump rather than a later snapshot of the live database.
   */
  const DUMP = [
    "SET statement_timeout = 0;",
    'COPY "auth"."users" ("id", "email") FROM stdin;',
    "1\tedward@example.com",
    "2\tviewer@example.com",
    "\\.",
    "",
    'COPY "public"."bottles" ("id", "notes") FROM stdin;',
    "a\tline one\\nline two",
    "b\t\\N",
    "c\tplain",
    "\\.",
    "",
    'COPY "public"."cellars" ("id") FROM stdin;',
    "z",
    "\\.",
  ].join("\n");

  it("counts the rows the dump actually contains", () => {
    expect(countDumpRows(DUMP)).toEqual({
      "auth.users": 2,
      "public.bottles": 3,
      "public.cellars": 1,
    });
  });

  it("counts a value with an escaped newline as ONE row", () => {
    // The row "a" holds a two-line value. Counting physical lines naively
    // would report 4 bottles instead of 3.
    expect(countDumpRows(DUMP)["public.bottles"]).toBe(3);
  });

  it("reports an empty table as 0 rather than omitting it", () => {
    const empty = 'COPY "public"."cellars" ("id") FROM stdin;\n\\.\n';
    expect(countDumpRows(empty)).toEqual({ "public.cellars": 0 });
  });

  /**
   * A truncated dump is the dangerous case: it parses, and a naive count
   * would report a plausible short number that looks like real data loss or,
   * worse, like success.
   */
  it("throws on a truncated COPY block instead of reporting a short count", () => {
    const truncated = 'COPY "public"."bottles" ("id") FROM stdin;\na\nb\n';
    expect(() => countDumpRows(truncated)).toThrow(/truncated/i);
    expect(() => countDumpRows(truncated)).toThrow(/public\.bottles/);
  });

  it("the empty-dump tripwire judges the DUMP's counts, not observed ones", () => {
    expect(checkCounts({ "auth.users": 2, "public.cellars": 1 }).ok).toBe(true);
    expect(checkCounts({ "auth.users": 0, "public.cellars": 1 }).ok).toBe(false);
    // A table absent from the dump is a problem, not a zero.
    const absent = checkCounts({ "public.cellars": 1 });
    expect(absent.ok).toBe(false);
    expect(absent.problems.join(" ")).toMatch(/absent from the dump/i);
  });

  /**
   * The two snapshots are expected to differ occasionally on a live
   * database. A divergence must be RECORDED, not treated as failure — and
   * never silently averaged into one number.
   */
  it("records snapshot differences without failing the backup", () => {
    const diffs = compareCounts(
      { "auth.users": 2, "public.bottles": 10 },
      { "auth.users": 2, "public.bottles": 11, "public.tastings": 4 },
    );
    expect(diffs).toEqual([
      { table: "public.bottles", dumped: 10, observed: 11, note: "different snapshot" },
      { table: "public.tastings", dumped: null, observed: 4, note: "not in dump" },
    ]);
  });

  /**
   * Referential integrity between `public` and `auth` is what a restore
   * depends on, so the data must come from ONE pg_dump invocation — one
   * repeatable-read snapshot. Two runs would be two snapshots.
   */
  it("dumps all data in a single invocation, for one consistent snapshot", () => {
    const plan = buildDumpPlan("cellar-atlas-2026-11-26T031705Z");
    const dataSteps = plan.filter((p) => p.kind === "data");
    expect(dataSteps.length, "data must be one step, not one per schema").toBe(1);
    const args = dataSteps[0]!.args.join(" ");
    expect(args).toContain("--schema public");
    expect(args).toContain("--schema auth");
  });

  it("run-backup records observed counts as observational, and never fails on them", () => {
    const src = readFileSync("scripts/backup/run-backup.mjs", "utf8");
    expect(src).toMatch(/observedRowCounts/);
    expect(src).toMatch(/observedAfterDump: true/);
    expect(src).toMatch(/dumpRowCounts/);
    // The gate is the dump's own counts.
    expect(src).toMatch(/checkCounts\(dumpRowCounts\)/);
    // An observation failure is caught and recorded, not thrown.
    expect(src).toMatch(/observationError/);
  });
});

/* ════ 3. RETENTION REASONS ABOUT COMPLETE SETS ════ */

describe("correction 3 — only complete backup sets count, and uploads are verified first", () => {
  const stemAt = (daysAgo: number) =>
    backupStem(new Date(Date.UTC(2026, 10, 26, 3, 17, 0) - daysAgo * 86_400_000));

  const objectsFor = (stem: string, omit: string[] = []) =>
    expectedSuffixes()
      .filter((s) => !omit.includes(s))
      .map((s) => `${stem}${s}`);

  it("a set is complete only when every file is present", () => {
    const full = objectsFor(stemAt(0));
    expect(groupIntoSets(full).complete.length).toBe(1);
    expect(groupIntoSets(full).incomplete.length).toBe(0);

    const partial = objectsFor(stemAt(0), [".data.sql.age"]);
    const grouped = groupIntoSets(partial);
    expect(grouped.complete.length).toBe(0);
    expect(grouped.incomplete.length).toBe(1);
    expect(grouped.incomplete[0]!.missing).toEqual([".data.sql.age"]);
  });

  /**
   * THE FINDING, STATED AS A TEST.
   *
   * Today's upload was interrupted, so today's set is incomplete. If that set
   * were allowed to satisfy the daily tier, a complete backup would be pruned
   * to make room for a broken one — losing a good copy to keep a bad one.
   */
  it("an incomplete set NEVER displaces a complete one", () => {
    const objects = [
      ...objectsFor(stemAt(0), [".data.sql.age"]), // today: interrupted
      ...Array.from({ length: 40 }, (_, i) => objectsFor(stemAt(i + 1))).flat(),
    ];
    const plan = planRetention(objects);

    // The incomplete set is neither kept as a tier member nor deleted.
    expect(plan.keepStems).not.toContain(stemAt(0));
    expect(plan.incompleteStems).toEqual([stemAt(0)]);
    for (const name of plan.incompleteObjects) {
      expect(plan.pruneObjects, "an in-flight upload must not be deleted").not.toContain(
        name,
      );
    }

    // The newest COMPLETE set is force-kept, and the daily tier is satisfied
    // by complete sets only.
    expect(plan.keepStems).toContain(stemAt(1));
    for (let i = 1; i <= 7; i++) expect(plan.keepStems).toContain(stemAt(i));
  });

  it("refuses to prune at all when no complete set exists", () => {
    const plan = planRetention([
      ...objectsFor(stemAt(0), [".data.sql.age"]),
      ...objectsFor(stemAt(1), [".manifest.json"]),
    ]);
    expect(plan.pruneObjects).toEqual([]);
    expect(plan.reason).toMatch(/no COMPLETE backup sets/i);
  });

  it("still ignores objects that are not ours, and never deletes them", () => {
    const plan = planRetention([
      ...objectsFor(stemAt(0)),
      ...objectsFor(stemAt(500)),
      "terraform.tfstate",
      "notes.txt",
      // Shares the stem but is not one of the set's files.
      `${stemAt(500)}.notes.txt`,
    ]);
    expect(plan.ignored).toContain("terraform.tfstate");
    expect(plan.ignored).toContain(`${stemAt(500)}.notes.txt`);
    for (const name of plan.ignored) expect(plan.pruneObjects).not.toContain(name);
  });

  it("classifyObject matches only an exact stem plus an exact suffix", () => {
    const stem = stemAt(0);
    expect(classifyObject(`${stem}.data.sql.age`)).toEqual({
      stem,
      suffix: ".data.sql.age",
    });
    // Near-misses must not be claimed as backup objects.
    for (const name of [
      `${stem}.data.sql.age.bak`,
      `${stem}.data.sql`,
      `copy-of-${stem}.data.sql.age`,
      `${stem}-notes.data.sql.age`,
    ]) {
      expect(classifyObject(name), name).toBeNull();
    }
  });

  /* ── upload verification ───────────────────────────────────────────── */

  const stem = "cellar-atlas-2026-11-26T031705Z";
  const manifest = {
    stem,
    dumpCountsOk: true,
    files: [
      { file: `${stem}.roles.sql.age`, encryptedSha256: "a".repeat(64) },
      { file: `${stem}.schema-public.sql.age`, encryptedSha256: "b".repeat(64) },
      { file: `${stem}.schema-auth.sql.age`, encryptedSha256: "c".repeat(64) },
      { file: `${stem}.data.sql.age`, encryptedSha256: "d".repeat(64) },
    ],
  };
  const goodHashes = () =>
    new Map<string, string>([
      [`${stem}.roles.sql.age`, "a".repeat(64)],
      [`${stem}.schema-public.sql.age`, "b".repeat(64)],
      [`${stem}.schema-auth.sql.age`, "c".repeat(64)],
      [`${stem}.data.sql.age`, "d".repeat(64)],
      [`${stem}.manifest.json`, "e".repeat(64)],
    ]);

  it("confirms a complete, intact upload", () => {
    const result = verifyUploadedSet({ stem, manifest, remoteHashes: goodHashes() });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(4);
    expect(pruneIsSafe(result)).toBe(true);
  });

  it("refuses when an object never arrived", () => {
    const hashes = goodHashes();
    hashes.delete(`${stem}.data.sql.age`);
    const result = verifyUploadedSet({ stem, manifest, remoteHashes: hashes });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/not readable from the bucket/);
    expect(pruneIsSafe(result)).toBe(false);
  });

  /** "Exists" and "intact" are different claims: a truncated upload exists. */
  it("refuses when an object arrived but its bytes differ", () => {
    const hashes = goodHashes();
    hashes.set(`${stem}.data.sql.age`, "f".repeat(64));
    const result = verifyUploadedSet({ stem, manifest, remoteHashes: hashes });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/SHA-256 mismatch/);
  });

  it("refuses when the manifest itself did not arrive", () => {
    const hashes = goodHashes();
    hashes.delete(`${stem}.manifest.json`);
    expect(verifyUploadedSet({ stem, manifest, remoteHashes: hashes }).ok).toBe(false);
  });

  it("refuses a set whose own row counts were rejected, however well it uploaded", () => {
    const bad = { ...manifest, dumpCountsOk: false };
    const result = verifyUploadedSet({ stem, manifest: bad, remoteHashes: goodHashes() });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/not a usable backup/);
  });

  it("refuses a manifest describing a different backup", () => {
    expect(
      verifyUploadedSet({
        stem: "cellar-atlas-2026-11-25T031705Z",
        manifest,
        remoteHashes: goodHashes(),
      }).ok,
    ).toBe(false);
  });

  it("the workflow verifies before it prunes, and prunes only on success", () => {
    const verifyAt = workflow.indexOf("Verify the upload against the manifest");
    const pruneAt = workflow.indexOf("Apply retention");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt, "verification must precede retention").toBeLessThan(pruneAt);
    // The gate is explicit, not merely implied by step order: a failed step
    // would otherwise still allow a later step to run under some conditions.
    expect(workflowCode).toMatch(/steps\.verify\.outcome == 'success'/);
    expect(workflowCode).toMatch(/verify-upload\.mjs/);
  });
});

/* ════ 4. DELETION IS BY EXACT NAME ════ */

describe("correction 4 — only exact object names are ever deleted", () => {
  const stem = backupStem(new Date(Date.UTC(2020, 0, 1, 3, 17, 0)));
  const newer = backupStem(new Date(Date.UTC(2026, 10, 26, 3, 17, 0)));

  it("planRetention returns exact object names, never stems", () => {
    const objects = [
      ...expectedSuffixes().map((s) => `${stem}${s}`),
      ...expectedSuffixes().map((s) => `${newer}${s}`),
      // 12 months of monthlies, so the 2020 set is genuinely surplus.
      ...Array.from({ length: 14 }, (_, i) =>
        expectedSuffixes().map(
          (s) => `${backupStem(new Date(Date.UTC(2026, 10 - i, 15, 3, 17, 0)))}${s}`,
        ),
      ).flat(),
    ];
    const plan = planRetention(objects);

    expect(plan.pruneStems).toContain(stem);
    // Every emitted name is a full object name belonging to a pruned set.
    for (const name of plan.pruneObjects) {
      expect(name, "a stem is not an object name").not.toBe(stem);
      expect(classifyObject(name), `${name} must be a recognised object`).not.toBeNull();
      expect(plan.pruneStems).toContain(classifyObject(name)!.stem);
    }
    // And the set's objects are all accounted for.
    expect(plan.pruneObjects.filter((n) => n.startsWith(stem)).length).toBe(
      expectedSuffixes().length,
    );
  });

  /**
   * THE DEFECT THIS REPLACES. `aws s3 rm --recursive --include "<stem>.*"`
   * would also match anything else sharing the prefix.
   */
  it("the workflow deletes one exact key per call, with no wildcard", () => {
    const pruneStep = workflow.slice(workflow.indexOf("Apply retention"));
    const block = pruneStep.slice(0, pruneStep.indexOf("- name: Raise an issue"));

    expect(block).toMatch(/aws s3 rm "s3:\/\/\$\{R2_BUCKET\}\/\$\{object\}"/);
    // None of these may appear on the delete call.
    const deleteCall = block.slice(block.indexOf("aws s3 rm"));
    expect(deleteCall).not.toMatch(/--recursive/);
    expect(deleteCall).not.toMatch(/--include/);
    expect(deleteCall).not.toMatch(/--exclude/);
    expect(deleteCall).not.toMatch(/\*/);
  });

  it("prune.mjs documents and emits object names, not stems", () => {
    const src = readFileSync("scripts/backup/prune.mjs", "utf8");
    expect(src).toMatch(/plan\.pruneObjects/);
    // It must not write stems to stdout, which the workflow consumes.
    const stdoutWrites = [...src.matchAll(/process\.stdout\.write\(([^)]*)\)/g)].map(
      (m) => m[1]!,
    );
    expect(stdoutWrites.length).toBeGreaterThan(0);
    for (const w of stdoutWrites) expect(w).not.toMatch(/pruneStems/);
  });
});

/* ════ 6 & 7. THE DUMP IS EXERCISED, AND RESTORE IS NOT OVERCLAIMED ════ */

describe("corrections 6 and 7 — the dump is exercised, and recovery is not claimed", () => {
  const docs = readFileSync("docs/disaster-recovery.md", "utf8");

  it("auth DDL is a separate file, so it need not be replayed into Supabase", () => {
    const plan = buildDumpPlan("cellar-atlas-2026-11-26T031705Z");
    const schemaSteps = plan.filter((p) => p.kind === "schema");
    expect(schemaSteps.map((s) => s.name)).toEqual(
      SCHEMA_DUMP_ORDER.map((s) => `schema-${s}`),
    );
    // Each schema dump names exactly one schema.
    for (const step of schemaSteps) {
      expect(step.args.filter((a) => a === "--schema").length).toBe(1);
    }
  });

  it("the documented restore order is the one that was actually tested", () => {
    // Found by running it: schema-public.sql contains CREATE SCHEMA "public",
    // which every database already has, so the restore aborts without this.
    expect(docs).toMatch(/drop schema public cascade/i);
    expect(docs).toMatch(/schema-auth/);
    expect(docs).toMatch(/ON_ERROR_STOP=1/);
  });

  it("the local integration-test procedure is documented and reproducible", () => {
    expect(docs).toMatch(/BACKUP_TEST_DATABASE_URL/);
    expect(docs).toMatch(/Local integration test/i);
    expect(docs).toMatch(/backup-dump-integration/);
  });

  it("Supabase-managed roles and schemas are reviewed, not glossed over", () => {
    expect(docs).toMatch(/Supabase-managed/i);
    expect(docs).toMatch(/already exists/i);
    expect(docs).toMatch(/GoTrue|platform-managed/i);
  });

  /**
   * The claim discipline the audit asked for. "Verified" is reserved for a
   * drill against a real Supabase project, which has not happened.
   */
  it("no state beyond 'code tested' is claimed as achieved", () => {
    const statusTable = docs.slice(
      docs.indexOf("## Status"),
      docs.indexOf("## What is backed up"),
    );
    expect(statusTable).toMatch(/Code tested/i);
    expect(statusTable).toMatch(/Restore verified/i);
    // Exactly one "Yes" in the status table: code tested.
    expect((statusTable.match(/\*\*Yes\*\*/g) ?? []).length).toBe(1);
    expect((statusTable.match(/\*\*No\*\*/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the workflow stays disabled pending the integration test", () => {
    expect(workflowCode).toMatch(/vars\.BACKUP_ENABLED/);
    expect(workflow).toMatch(/integration test/i);
  });
});
