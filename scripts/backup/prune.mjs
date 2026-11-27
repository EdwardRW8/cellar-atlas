#!/usr/bin/env node
/**
 * APPLY RETENTION TO THE OBJECTS IN THE BUCKET.
 *
 * This script decides; it does not delete. It reads every object name in the
 * bucket on stdin (one per line, as `aws s3 ls | awk '{print $4}'` produces)
 * and prints the EXACT object names to remove.
 *
 * Separating the decision from the deletion is deliberate. The decision is
 * pure and exhaustively tested; the deletion is three lines of workflow that
 * can be read at a glance. A single script that listed, decided and deleted
 * would be the hardest part of the system to test and the only part that can
 * lose data.
 *
 * ── EXACT NAMES, NEVER STEMS OR WILDCARDS ────────────────────────────────
 * stdout carries full object names. The caller deletes each one individually.
 * An earlier version emitted stems and the workflow deleted with
 * `--include "<stem>.*"`, which would also match any unrelated object that
 * merely shared the prefix — `cellar-atlas-…Z.notes.txt`, or a half-renamed
 * file someone left behind. A wildcard is not a name.
 *
 * ── INCOMPLETE SETS ARE REPORTED, NEVER DELETED, NEVER COUNTED ───────────
 * A set missing any of its files cannot satisfy a retention tier, so it can
 * never displace a complete backup. It is also never deleted here: it may be
 * an upload still in flight. It is listed on stderr for a human to resolve.
 *
 * --dry-run prints the plan and emits nothing to delete, so the workflow can
 * be run once in report-only mode before it is trusted.
 *
 * Usage:
 *   aws s3 ls s3://bucket/ | awk '{print $4}' | node scripts/backup/prune.mjs
 *   ... | node scripts/backup/prune.mjs --dry-run
 */

import { readFileSync } from "node:fs";
import { planRetention, RETENTION } from "./lib/retention.mjs";

const dryRun = process.argv.includes("--dry-run");

const objectNames = readFileSync(0, "utf8")
  .split("\n")
  .map((l) => l.trim().replace(/\/$/, ""))
  .filter((l) => l !== "");

const plan = planRetention(objectNames);

for (const name of plan.ignored) {
  console.error(`prune: ignoring unrecognised object ${name}`);
}
for (const stem of plan.incompleteStems) {
  console.error(
    `prune: INCOMPLETE set ${stem} — not counted towards retention, and not deleted. ` +
      `Resolve it by hand; see docs/disaster-recovery.md.`,
  );
}

if (plan.reason) {
  console.error(`prune: ${plan.reason} — nothing will be deleted`);
  // Not an error: an empty or unrecognised bucket is not a failure, and a
  // bucket holding only incomplete sets must not fail the backup that just
  // succeeded. The workflow has already verified its own upload by this
  // point, so a refusal here means there is simply nothing safe to prune.
  process.exit(0);
}

console.error(
  `prune: ${plan.keepStems.length} complete sets kept ` +
    `(${RETENTION.daily} daily / ${RETENTION.weekly} weekly / ${RETENTION.monthly} monthly), ` +
    `${plan.pruneStems.length} sets to remove (${plan.pruneObjects.length} objects), ` +
    `${plan.incompleteStems.length} incomplete left alone, ${plan.ignored.length} ignored`,
);

if (dryRun) {
  for (const name of plan.pruneObjects) console.error(`prune: WOULD remove ${name}`);
  process.exit(0);
}

// stdout is the machine-readable answer: exact object names, one per line.
for (const name of plan.pruneObjects) process.stdout.write(`${name}\n`);
