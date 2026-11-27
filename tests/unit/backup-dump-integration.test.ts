/**
 * THE DUMP AND RESTORE, AGAINST A REAL POSTGRES.
 *
 * Everything else about the backup is tested without a database: argv
 * construction, retention arithmetic, the recipient refusals. None of that
 * proves `pg_dump` produces a file that restores, that the manifest's counts
 * describe the dump, or that the restore order works. Those are the claims a
 * recovery actually depends on, and they need a server.
 *
 * ── HOW TO RUN IT ────────────────────────────────────────────────────────
 * It SKIPS unless `BACKUP_TEST_DATABASE_URL` points at a **disposable**
 * Postgres. CI does not set it, so CI does not need a database. The exact
 * procedure for standing one up locally is in docs/disaster-recovery.md
 * under "Local integration test".
 *
 *   BACKUP_TEST_DATABASE_URL='postgresql://u:p@127.0.0.1:55432/postgres?sslmode=disable' \
 *     npx vitest run tests/unit/backup-dump-integration.test.ts
 *
 * ── IT WILL CREATE AND DROP DATABASES ────────────────────────────────────
 * It creates `cellar_backup_src` and `cellar_backup_restored` and drops them
 * both. It refuses to run against anything that is not a loopback host, so it
 * cannot be pointed at production by accident — and the backup workflow stays
 * disabled regardless of whether this has ever been run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countDumpRows } from "../../scripts/backup/lib/dump-plan.mjs";

const URL_FROM_ENV = process.env.BACKUP_TEST_DATABASE_URL ?? "";

/** Only loopback. A test that creates and drops databases must not roam. */
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ["127.0.0.1", "localhost", "::1"].includes(host);
  } catch {
    return false;
  }
}

const haveTools = ["pg_dump", "psql", "age", "age-keygen"].every(
  (bin) => spawnSync("which", [bin]).status === 0,
);
const enabled = URL_FROM_ENV !== "" && isLoopback(URL_FROM_ENV) && haveTools;

const SRC_DB = "cellar_backup_src";
const DST_DB = "cellar_backup_restored";

/** The fixture: the real shape, including a value with a newline and a tab. */
const FIXTURE_SQL = `
create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  encrypted_password text not null
);
create table public.cellars (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id)
);
create table public.cellar_members (
  cellar_id uuid references public.cellars(id),
  user_id uuid references auth.users(id),
  role text not null,
  primary key (cellar_id, user_id)
);
create table public.wine_definitions (
  id uuid primary key default gen_random_uuid(),
  cellar_id uuid references public.cellars(id),
  producer text not null,
  name text not null,
  notes text
);
create table public.bottles (
  id uuid primary key default gen_random_uuid(),
  wine_definition_id uuid references public.wine_definitions(id),
  status text not null default 'in_cellar'
);
insert into auth.users (email, encrypted_password)
  values ('owner@example.test', '$2a$10$notarealhash'),
         ('viewer@example.test', '$2a$10$alsonotreal');
insert into public.cellars (name, created_by)
  select 'My Cellar', id from auth.users where email = 'owner@example.test';
insert into public.cellar_members (cellar_id, user_id, role)
  select c.id, u.id, 'owner' from public.cellars c, auth.users u
  where u.email = 'owner@example.test';
insert into public.wine_definitions (cellar_id, producer, name, notes)
  select c.id, 'Château Margaux', 'Grand Vin', E'line one\\nline two\\twith tab'
  from public.cellars c;
insert into public.wine_definitions (cellar_id, producer, name)
  select c.id, 'Domaine Leflaive', 'Puligny' from public.cellars c;
insert into public.bottles (wine_definition_id)
  select id from public.wine_definitions, generate_series(1, 3);
`;

/** Expected rows, as the fixture defines them. */
const EXPECTED = {
  "auth.users": 2,
  "public.cellars": 1,
  "public.cellar_members": 1,
  "public.wine_definitions": 2,
  "public.bottles": 6,
};

let work = "";
let outDir = "";
let keyFile = "";
let recipientFile = "";
let stem = "";
let manifest: Record<string, never> | Record<string, unknown> = {};

/** Rewrite the URL's database name, keeping credentials in the env only. */
function urlFor(db: string): string {
  const u = new URL(URL_FROM_ENV);
  u.pathname = `/${db}`;
  return u.toString();
}

function psql(db: string, args: string[]): string {
  return execFileSync("psql", ["-d", urlFor(db), "-v", "ON_ERROR_STOP=1", "-q", ...args], {
    encoding: "utf8",
  });
}

describe.skipIf(!enabled)("the dump and restore work against a real Postgres", () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "backup-int-"));
    outDir = join(work, "out");
    keyFile = join(work, "key.txt");
    recipientFile = join(work, "recipient.txt");

    // A throwaway key pair: nothing here touches the owner's real key.
    const keygen = execFileSync("age-keygen", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(keyFile, keygen);
    const pub = /public key: (age1[0-9a-z]+)/i.exec(keygen)![1]!;
    writeFileSync(recipientFile, `${pub}\n`);

    psql("postgres", [
      "-c",
      `drop database if exists ${SRC_DB}`,
      "-c",
      `create database ${SRC_DB}`,
    ]);
    psql(SRC_DB, ["-c", FIXTURE_SQL]);
  });

  afterAll(() => {
    if (!enabled) return;
    try {
      psql("postgres", [
        "-c",
        `drop database if exists ${SRC_DB}`,
        "-c",
        `drop database if exists ${DST_DB}`,
      ]);
    } catch {
      /* the cluster is disposable; a failed cleanup must not fail the suite */
    }
    if (work && existsSync(work)) rmSync(work, { recursive: true, force: true });
  });

  it("produces four encrypted dumps and a manifest, and no plaintext", () => {
    execFileSync(
      "node",
      ["scripts/backup/run-backup.mjs", "--out", outDir, "--recipient", recipientFile],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: urlFor(SRC_DB) } },
    );

    const files = readdirSync(outDir).sort();
    expect(files.filter((f) => f.endsWith(".sql"))).toEqual([]); // plaintext destroyed
    expect(files.filter((f) => f.endsWith(".age")).length).toBe(4);

    const manifestName = files.find((f) => f.endsWith(".manifest.json"))!;
    stem = manifestName.replace(".manifest.json", "");
    manifest = JSON.parse(readFileSync(join(outDir, manifestName), "utf8"));

    expect(files.sort()).toEqual(
      [
        `${stem}.data.sql.age`,
        `${stem}.manifest.json`,
        `${stem}.roles.sql.age`,
        `${stem}.schema-auth.sql.age`,
        `${stem}.schema-public.sql.age`,
      ].sort(),
    );
  });

  /**
   * THE CORRECTION THIS TEST EXISTS FOR. The manifest's authoritative counts
   * must describe the dump, not a later query against the live database.
   */
  it("the manifest's dumpRowCounts match the dump's own contents exactly", () => {
    const m = manifest as { dumpRowCounts: Record<string, number>; dumpCountsOk: boolean };
    expect(m.dumpCountsOk).toBe(true);
    for (const [table, rows] of Object.entries(EXPECTED)) {
      expect(m.dumpRowCounts[table], `${table} in the manifest`).toBe(rows);
    }
  });

  it("the manifest records the transport security actually used", () => {
    const m = manifest as { sslmode: string; transportEncrypted: boolean };
    expect(typeof m.sslmode).toBe("string");
    // Loopback testing uses sslmode=disable; the manifest must say so plainly
    // rather than implying the dump travelled encrypted.
    expect(m.transportEncrypted).toBe(m.sslmode !== "disable");
  });

  it("the manifest contains no credential", () => {
    const raw = readFileSync(join(outDir, `${stem}.manifest.json`), "utf8");
    const password = new URL(URL_FROM_ENV).password;
    if (password) expect(raw).not.toContain(password);
  });

  it("every encrypted file decrypts and matches its recorded hash", () => {
    const m = manifest as { files: { file: string; plaintextSha256: string }[] };
    for (const entry of m.files) {
      const plain = join(work, entry.file.replace(/\.age$/, ""));
      execFileSync("age", [
        "--decrypt",
        "--identity",
        keyFile,
        "-o",
        plain,
        join(outDir, entry.file),
      ]);
      const hash = createHash("sha256").update(readFileSync(plain)).digest("hex");
      expect(hash, `${entry.file} decrypted`).toBe(entry.plaintextSha256);
    }
  });

  it("countDumpRows agrees when run directly over the decrypted dump", () => {
    const dataSql = readFileSync(join(work, `${stem}.data.sql`), "utf8");
    const counted = countDumpRows(dataSql);
    for (const [table, rows] of Object.entries(EXPECTED)) {
      expect(counted[table], `${table} counted from the dump`).toBe(rows);
    }
  });

  /**
   * THE RESTORE, IN THE ORDER docs/disaster-recovery.md PRESCRIBES.
   *
   * The `drop schema public` step is not optional and was found by running
   * this: `schema-public.sql` contains `CREATE SCHEMA "public"`, and every
   * Postgres database already has one, so under ON_ERROR_STOP=1 the restore
   * aborts on its first statement without it.
   */
  it("restores cleanly into a fresh database under ON_ERROR_STOP=1", () => {
    psql("postgres", [
      "-c",
      `drop database if exists ${DST_DB}`,
      "-c",
      `create database ${DST_DB}`,
    ]);
    psql(DST_DB, ["-c", "drop schema public cascade"]);

    for (const step of ["schema-auth", "schema-public", "data"]) {
      // Throws on any error, which is the assertion.
      psql(DST_DB, ["-f", join(work, `${stem}.${step}.sql`)]);
    }
  });

  it("the restored row counts match the manifest's dumpRowCounts", () => {
    const m = manifest as { dumpRowCounts: Record<string, number> };
    for (const [table, expected] of Object.entries(EXPECTED)) {
      const out = psql(DST_DB, ["-tA", "-c", `select count(*) from ${table}`]).trim();
      expect(Number(out), `${table} restored`).toBe(expected);
      expect(Number(out), `${table} vs manifest`).toBe(m.dumpRowCounts[table]);
    }
  });

  it("values containing newlines and tabs survive the round trip", () => {
    const out = psql(DST_DB, [
      "-tA",
      "-c",
      "select notes from public.wine_definitions where notes is not null",
    ]);
    expect(out).toContain("line one");
    expect(out).toContain("line two\twith tab");
  });

  it("foreign keys across public and auth are intact after the restore", () => {
    const out = psql(DST_DB, [
      "-tA",
      "-c",
      `select count(*) from public.bottles b
         join public.wine_definitions w on w.id = b.wine_definition_id
         join public.cellars c on c.id = w.cellar_id
         join auth.users u on u.id = c.created_by`,
    ]).trim();
    // Every bottle still reaches a real user through the whole chain. This is
    // what dumping auth in the SAME pg_dump run as public buys.
    expect(Number(out)).toBe(EXPECTED["public.bottles"]);
  });
});

describe("the integration test announces itself when it cannot run", () => {
  it("is skipped only for a stated reason", () => {
    if (enabled) return;
    const reason = !haveTools
      ? "pg_dump/psql/age not installed"
      : URL_FROM_ENV === ""
        ? "BACKUP_TEST_DATABASE_URL is not set"
        : "BACKUP_TEST_DATABASE_URL is not a loopback host";
    // Deliberately not a silent skip: a reader of CI output should be able to
    // see that the dump was NOT exercised, and why.
    console.warn(`backup integration test skipped: ${reason}`);
    expect(reason.length).toBeGreaterThan(0);
  });

  it("refuses a non-loopback target even if one is supplied", () => {
    expect(isLoopback("postgresql://u:p@db.supabase.co:5432/postgres")).toBe(false);
    expect(isLoopback("postgresql://u:p@127.0.0.1:55432/postgres")).toBe(true);
    expect(isLoopback("not a url")).toBe(false);
  });
});
