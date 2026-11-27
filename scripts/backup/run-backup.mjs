#!/usr/bin/env node
/**
 * TAKE ONE ENCRYPTED BACKUP.
 *
 * Order is the safety property, and it is enforced structurally rather than
 * by discipline: this script encrypts each dump and DELETES the plaintext
 * before it exits. The workflow's upload step therefore has nothing
 * unencrypted left to upload — it is not that we remember not to upload the
 * plaintext, it is that the plaintext is gone.
 *
 *   validate recipient  (refuses the committed placeholder)
 *     → pg_dump: roles, schema-public, schema-auth, and data in ONE run
 *     → count the rows THE DUMP CONTAINS, and refuse if it looks empty
 *     → observe live counts separately, recorded as observational only
 *     → age-encrypt each dump
 *     → delete plaintext
 *     → leave only *.age and the manifest in --out
 *
 * The recipient is validated FIRST, before a single byte is dumped. Dumping
 * production data we then cannot encrypt would mean holding it in clear on
 * the runner, and the useful moment to discover a missing key is before that.
 *
 * Usage:
 *   node scripts/backup/run-backup.mjs --out <dir>
 *   node scripts/backup/run-backup.mjs --out <dir> --dry-run
 *
 * --dry-run prints the exact plan — commands, filenames, recipient
 * fingerprint — and connects to nothing. It is how the workflow can be
 * exercised, and how this script is tested, without a production credential.
 *
 * Environment:
 *   DATABASE_URL    required (except --dry-run). Never logged, never in argv.
 *   BACKUP_CA_CERT  optional path to a CA bundle. When set, the default
 *                   sslmode rises to verify-full, which authenticates the
 *                   server rather than merely encrypting to it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pgEnvFromUrl, describeTarget, isSecureSslmode } from "./lib/connection.mjs";
import { readRecipient, RECIPIENT_PATH } from "./lib/recipient.mjs";
import {
  buildDumpPlan,
  MANIFEST_COUNT_QUERY,
  checkCounts,
  countDumpRows,
  compareCounts,
  BACKUP_SCHEMAS,
} from "./lib/dump-plan.mjs";
import { backupStem } from "./lib/retention.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

function die(message) {
  // stderr, never stdout: stdout carries the machine-readable summary.
  console.error(`backup: ${message}`);
  process.exit(1);
}

/** Run a child, inheriting nothing from our own env except what is asked. */
function run(command, args, { env = {}, stdoutFile = null } = {}) {
  const result = spawnSync(command, args, {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: stdoutFile ? "buffer" : "utf8",
    maxBuffer: 1024 * 1024 * 512,
  });
  if (result.error) {
    throw new Error(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    // stderr from pg_dump/age may name the host but never the password,
    // which travels in the environment and is not echoed by either tool.
    const detail = (result.stderr || "").toString().trim().split("\n").slice(-5).join("\n");
    throw new Error(`${command} exited ${result.status}\n${detail}`);
  }
  if (stdoutFile) writeFileSync(stdoutFile, result.stdout);
  return (result.stdout || "").toString();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A short, non-secret fingerprint of the public recipient, for the log. */
function recipientFingerprint(recipient) {
  return createHash("sha256").update(recipient).digest("hex").slice(0, 16);
}

function main() {
  const outDir = arg("out");
  if (!outDir) die("--out <dir> is required");
  const dryRun = has("dry-run");

  // ── 1. The recipient, before anything is dumped ──────────────────────────
  let recipient;
  try {
    recipient = readRecipient(arg("recipient", RECIPIENT_PATH));
  } catch (e) {
    die(e.message);
  }

  const caCertPath = process.env.BACKUP_CA_CERT || null;
  if (caCertPath && !existsSync(caCertPath)) {
    die(`BACKUP_CA_CERT points at ${caCertPath}, which does not exist.`);
  }

  const startedAt = new Date();
  const stem = backupStem(startedAt);
  const plan = buildDumpPlan(stem);

  if (dryRun) {
    const summary = {
      mode: "dry-run",
      stem,
      schemas: BACKUP_SCHEMAS,
      recipientFingerprint: recipientFingerprint(recipient),
      caCertConfigured: Boolean(caCertPath),
      steps: plan.map((p) => ({
        name: p.name,
        plaintext: p.file,
        encrypted: `${p.file}.age`,
        argv: [p.command, ...p.args],
      })),
      manifest: `${stem}.manifest.json`,
      note: "No database connection attempted. No plaintext written.",
    };
    // Proves the property the tests care about: no argv carries a credential.
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  // ── 2. Connect details, from the environment only ────────────────────────
  let pgEnv;
  try {
    pgEnv = pgEnvFromUrl(process.env.DATABASE_URL, { caCertPath });
  } catch (e) {
    die(e.message);
  }

  mkdirSync(outDir, { recursive: true });
  // Plaintext lands in a private temp directory, never in --out, so even an
  // abnormal exit cannot leave a readable dump where the upload step looks.
  const work = mkdtempSync(join(tmpdir(), "cellar-backup-"));

  const files = [];
  try {
    // ── 3. Dump ───────────────────────────────────────────────────────────
    for (const step of plan) {
      const target = join(work, step.file);
      run(step.command, step.args, { env: pgEnv, stdoutFile: target });
      files.push({ ...step, plaintextPath: target });
      console.error(`backup: dumped ${step.name}`);
    }

    // ── 4. VERIFIED counts, from the dump itself ──────────────────────────
    // These describe the artefact, not the live database, and they are what
    // a restore must be checked against. countDumpRows throws on a truncated
    // COPY block rather than reporting a plausible-looking short count.
    const dataStep = files.find((f) => f.kind === "data");
    const dumpRowCounts = countDumpRows(readFileSync(dataStep.plaintextPath, "utf8"));

    const verdict = checkCounts(dumpRowCounts);
    if (!verdict.ok && !has("allow-empty")) {
      throw new Error(
        `refusing to keep a backup that looks wrong:\n  ${verdict.problems.join("\n  ")}`,
      );
    }

    // ── 5. OBSERVED counts, recorded as observational only ────────────────
    // A separate query is a separate snapshot, taken after the dump. On a
    // live database these are EXPECTED to differ sometimes, so a divergence
    // is recorded for a human rather than treated as failure.
    const observedRowCounts = {};
    let observationError = null;
    try {
      const raw = run(
        "psql",
        [
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--field-separator=|",
          "--command",
          MANIFEST_COUNT_QUERY,
        ],
        { env: pgEnv },
      );
      for (const line of raw.split("\n")) {
        const [table, rows] = line.split("|");
        if (table && rows !== undefined) observedRowCounts[table.trim()] = Number(rows.trim());
      }
    } catch (e) {
      // Must never fail the backup: the dump is already verified by its own
      // counts, and this is only a cross-check.
      observationError = e.message;
      console.error("backup: live row observation failed (the dump is unaffected)");
    }

    // ── 6. Encrypt, then destroy the plaintext ────────────────────────────
    const manifestFiles = [];
    for (const f of files) {
      const encrypted = join(outDir, `${f.file}.age`);
      run("age", [
        "--encrypt",
        "--recipient",
        recipient,
        "--output",
        encrypted,
        f.plaintextPath,
      ]);
      manifestFiles.push({
        file: `${f.file}.age`,
        kind: f.kind,
        plaintextSha256: sha256(f.plaintextPath),
        encryptedSha256: sha256(encrypted),
      });
      rmSync(f.plaintextPath, { force: true });
      console.error(`backup: encrypted ${f.name}`);
    }

    // ── 7. Manifest. Counts and hashes only: no credential, no wine data,
    //       and readable WITHOUT the private key so freshness and integrity
    //       can be monitored without decrypting anything.
    const manifest = {
      stem,
      takenAt: startedAt.toISOString(),
      source: describeTarget(pgEnv),
      sslmode: pgEnv.PGSSLMODE,
      sslVerified: pgEnv.PGSSLMODE.startsWith("verify"),
      transportEncrypted: isSecureSslmode(pgEnv.PGSSLMODE),
      schemas: BACKUP_SCHEMAS,
      recipientFingerprint: recipientFingerprint(recipient),

      // AUTHORITATIVE. Derived from the dump bytes, so they describe this
      // backup. Compare a restore against these.
      dumpRowCounts,
      dumpCountsOk: verdict.ok,
      dumpCountProblems: verdict.problems,

      // OBSERVATIONAL ONLY. A different snapshot of the live database, taken
      // after the dump. Not a property of this backup; never use for restore
      // verification. See docs/disaster-recovery.md.
      observedRowCounts,
      observedAfterDump: true,
      observationError,
      snapshotDifferences: observationError
        ? null
        : compareCounts(dumpRowCounts, observedRowCounts),

      files: manifestFiles,
      restore: "docs/disaster-recovery.md",
    };
    const manifestPath = join(outDir, `${stem}.manifest.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    process.stdout.write(
      `${JSON.stringify({ stem, ok: true, files: manifestFiles.length + 1 })}\n`,
    );
  } finally {
    // Whatever happened, no plaintext survives this process.
    rmSync(work, { recursive: true, force: true });
  }
}

main();
