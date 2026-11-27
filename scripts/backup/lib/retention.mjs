/**
 * WHICH BACKUPS TO KEEP, AND — MORE IMPORTANTLY — WHICH TO DELETE.
 *
 * This is the only code in the backup system that destroys anything, so it is
 * written to be read rather than to be clever, and it is pure so that it can
 * be tested exhaustively without a bucket.
 *
 * Grandfather-father-son: 7 daily, 4 weekly, 12 monthly. A single backup can
 * satisfy several tiers at once — the newest is simultaneously today's daily,
 * this week's weekly and this month's monthly — so tiers are unioned, never
 * counted separately.
 *
 * ── IT REASONS ABOUT COMPLETE SETS, NOT FILENAMES ────────────────────────
 * A backup is four encrypted files plus a manifest. An interrupted upload
 * leaves a stem with only some of them. Treating that stem as "today's
 * backup" would let it satisfy the daily tier and push a complete, known-good
 * backup out of retention — losing a good copy to keep a broken one. That is
 * the worst outcome this module could produce, so:
 *
 *   - only COMPLETE sets are eligible to satisfy any tier;
 *   - incomplete sets are reported separately and NEVER deleted here, because
 *     an incomplete set may be an upload still in flight;
 *   - deletion is emitted as EXACT object names, never a stem or a wildcard.
 *
 * Three refusals are deliberate, and each is pinned by a test:
 *
 *   1. Anything whose name does not match the backup pattern is IGNORED, not
 *      pruned. A prune that can only recognise its own output cannot delete
 *      someone else's object, whatever else ends up in the bucket.
 *   2. The newest complete backup is never pruned, under any arithmetic.
 *   3. If the result would keep no complete set, nothing is pruned at all and
 *      the caller is told. Deleting the last good copy to satisfy a retention
 *      rule is the one outcome worse than keeping too much.
 */

import { expectedSuffixes } from "./dump-plan.mjs";

/**
 * `cellar-atlas-2026-11-26T143000Z` — UTC, sortable as text, and specific
 * enough that two runs on the same day do not collide.
 */
export const BACKUP_NAME_PATTERN =
  /^cellar-atlas-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** The stem shared by every file of one backup set. */
export function backupStem(date) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `cellar-atlas-${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-` +
    `${p(date.getUTCDate())}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}` +
    `${p(date.getUTCSeconds())}Z`
  );
}

/** The instant a backup stem refers to, or null when it is not one of ours. */
export function parseBackupStem(stem) {
  const m = BACKUP_NAME_PATTERN.exec(stem);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Round-trip check: rejects 2026-02-31, which Date would silently roll over.
  return backupStem(date) === stem ? date : null;
}

/**
 * Split an object name into its set's stem and its suffix.
 *
 * Exact and anchored: the name must be a recognised stem followed by one of
 * the suffixes a backup set contains, and nothing else. `cellar-atlas-…Z.data.sql.age.bak`
 * is not a backup object, and neither is `cellar-atlas-…Z-notes.txt`.
 */
export function classifyObject(name) {
  for (const suffix of expectedSuffixes()) {
    if (!name.endsWith(suffix)) continue;
    const stem = name.slice(0, -suffix.length);
    if (parseBackupStem(stem)) return { stem, suffix };
  }
  return null;
}

const DAY_MS = 86_400_000;

/** UTC calendar day, e.g. "2026-11-26". */
function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

/** UTC month, e.g. "2026-11". */
function monthKey(d) {
  return d.toISOString().slice(0, 7);
}

/**
 * ISO-8601 week key, e.g. "2026-W48".
 *
 * Computed rather than approximated: "every 7 days from an arbitrary epoch"
 * drifts against the calendar and would make weekly retention keep two
 * backups from one week and none from the next.
 */
function weekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weeks run Monday-Sunday; getUTCDay() returns 0 for Sunday.
  const isoDay = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + 4 - isoDay); // move to that week's Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const RETENTION = { daily: 7, weekly: 4, monthly: 12 };

/**
 * Group object names into backup sets, and say which are complete.
 *
 * @param {string[]} objectNames Every object in the bucket, in any order.
 */
export function groupIntoSets(objectNames) {
  const required = expectedSuffixes();
  const sets = new Map();
  const ignored = [];

  for (const name of objectNames) {
    const classified = classifyObject(name);
    if (!classified) {
      ignored.push(name);
      continue;
    }
    const { stem, suffix } = classified;
    if (!sets.has(stem)) {
      sets.set(stem, { stem, date: parseBackupStem(stem), objects: new Map() });
    }
    sets.get(stem).objects.set(suffix, name);
  }

  const complete = [];
  const incomplete = [];
  for (const set of sets.values()) {
    const missing = required.filter((s) => !set.objects.has(s));
    const entry = {
      stem: set.stem,
      date: set.date,
      objectNames: [...set.objects.values()].sort(),
      missing,
    };
    (missing.length === 0 ? complete : incomplete).push(entry);
  }

  complete.sort((a, b) => b.date - a.date);
  incomplete.sort((a, b) => b.date - a.date);
  return { complete, incomplete, ignored };
}

/**
 * Keep the newest set in each of the most recent N buckets of a tier.
 * Returns the chosen stems.
 */
function newestPerBucket(sets, keyOf, howMany) {
  const newestIn = new Map();
  for (const s of sets) {
    const key = keyOf(s.date);
    const held = newestIn.get(key);
    if (!held || s.date > held.date) newestIn.set(key, s);
  }
  return [...newestIn.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // newest bucket first
    .slice(0, howMany)
    .map(([, s]) => s.stem);
}

/**
 * Decide the fate of every object given.
 *
 * @param {string[]} objectNames Every object in the bucket.
 * @param {object}   [opts]
 * @param {object}   [opts.retention] Override the 7/4/12 tiers.
 * @returns {{
 *   keepStems: string[], pruneStems: string[], pruneObjects: string[],
 *   incompleteStems: string[], incompleteObjects: string[],
 *   ignored: string[], reason: string|null
 * }}
 *   `pruneObjects` is the ONLY thing a caller should delete, and it is a list
 *   of exact object names. `incompleteObjects` is reported for a human and is
 *   never included in `pruneObjects`.
 */
export function planRetention(objectNames, opts = {}) {
  const retention = { ...RETENTION, ...(opts.retention ?? {}) };
  const { complete, incomplete, ignored } = groupIntoSets(objectNames);

  const incompleteStems = incomplete.map((s) => s.stem);
  const incompleteObjects = incomplete.flatMap((s) => s.objectNames);

  const empty = {
    keepStems: [],
    pruneStems: [],
    pruneObjects: [],
    incompleteStems,
    incompleteObjects,
    ignored,
  };

  if (complete.length === 0) {
    return {
      ...empty,
      reason:
        incomplete.length > 0
          ? `no COMPLETE backup sets found (${incomplete.length} incomplete) — refusing to prune`
          : "no backups found",
    };
  }

  const keep = new Set([
    // Refusal 2: the newest complete set is kept before any tier is considered.
    complete[0].stem,
    ...newestPerBucket(complete, dayKey, retention.daily),
    ...newestPerBucket(complete, weekKey, retention.weekly),
    ...newestPerBucket(complete, monthKey, retention.monthly),
  ]);

  const pruned = complete.filter((s) => !keep.has(s.stem));

  // Refusal 3. Unreachable while the newest is force-kept, which is the
  // point: it stays as a second lock on the one unrecoverable mistake.
  if (keep.size === 0 && pruned.length > 0) {
    return { ...empty, reason: "refused: would keep no complete backup" };
  }

  return {
    keepStems: [...keep].sort().reverse(),
    pruneStems: pruned.map((s) => s.stem).sort().reverse(),
    // Correction 4: exact names only. A stem or a wildcard could match an
    // unrelated object that merely shares the prefix.
    pruneObjects: pruned.flatMap((s) => s.objectNames).sort(),
    incompleteStems,
    incompleteObjects,
    ignored,
    reason: null,
  };
}
