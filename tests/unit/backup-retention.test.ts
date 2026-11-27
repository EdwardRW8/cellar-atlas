/**
 * RETENTION IS THE ONLY PART OF THE BACKUP SYSTEM THAT DESTROYS ANYTHING.
 *
 * So it is tested the way destructive code should be: against the calendar
 * rather than against "roughly seven days", and with the refusals asserted as
 * hard behaviour rather than described in a comment.
 *
 * The failure this is really guarding against is not "kept one file too many".
 * It is a prune that deletes a year of monthlies because of an off-by-one, or
 * that deletes an object it never recognised, and is noticed at a restore.
 *
 * NOTE ON THE API: retention reasons about complete backup SETS and emits
 * exact object names. Set-completeness and the verify-before-prune rule are
 * covered in tests/unit/backup-corrections.test.ts; this file covers the
 * calendar arithmetic and the refusals, over complete sets throughout.
 */

import { describe, it, expect } from "vitest";
import {
  planRetention,
  backupStem,
  parseBackupStem,
  RETENTION,
} from "../../scripts/backup/lib/retention.mjs";
import { expectedSuffixes } from "../../scripts/backup/lib/dump-plan.mjs";

/** A backup stem N days before the given instant, at a fixed time of day. */
function stemDaysAgo(days: number, from = Date.UTC(2026, 10, 26, 3, 17, 0)): string {
  return backupStem(new Date(from - days * 86_400_000));
}

/** Every object of one COMPLETE backup set. */
function objectsFor(stem: string): string[] {
  return expectedSuffixes().map((s) => `${stem}${s}`);
}

/** `days` complete sets, one a day, newest first. */
function dailySeries(days: number): string[] {
  return Array.from({ length: days }, (_, i) => objectsFor(stemDaysAgo(i))).flat();
}

describe("backup names round-trip, and only ours are recognised", () => {
  it("formats and parses the same instant", () => {
    const d = new Date(Date.UTC(2026, 10, 26, 3, 17, 5));
    expect(backupStem(d)).toBe("cellar-atlas-2026-11-26T031705Z");
    expect(parseBackupStem(backupStem(d))?.toISOString()).toBe(d.toISOString());
  });

  it.each([
    "backup-2026-11-26T031705Z",
    "cellar-atlas-2026-11-26",
    "cellar-atlas-2026-11-26T0317Z",
    "cellar-atlas-2026-13-01T000000Z", // month 13
    "cellar-atlas-2026-02-31T000000Z", // a date that does not exist
    "notes.txt",
    "",
  ])("refuses to recognise %s", (name) => {
    expect(parseBackupStem(name)).toBeNull();
  });

  /**
   * THE RULE THAT MATTERS MOST. A prune that can only recognise its own
   * output cannot delete anything else, whatever ends up in the bucket.
   */
  it("never prunes an object it does not recognise", () => {
    const objects = [
      ...dailySeries(1),
      ...objectsFor(stemDaysAgo(400)),
      "important-notes.txt",
      "terraform.tfstate",
    ];
    const plan = planRetention(objects);
    expect(plan.ignored.sort()).toEqual(["important-notes.txt", "terraform.tfstate"]);
    for (const name of plan.ignored) expect(plan.pruneObjects).not.toContain(name);
  });
});

describe("grandfather-father-son: 7 daily, 4 weekly, 12 monthly", () => {
  it("keeps everything while there is less than a week of history", () => {
    const plan = planRetention(dailySeries(5));
    expect(plan.keepStems.length).toBe(5);
    expect(plan.pruneObjects).toEqual([]);
  });

  it("keeps the 7 most recent days", () => {
    const plan = planRetention(dailySeries(30));
    for (let i = 0; i < RETENTION.daily; i++) {
      expect(plan.keepStems, `day -${i} must be kept`).toContain(stemDaysAgo(i));
    }
  });

  it("thins older history instead of keeping all of it", () => {
    const plan = planRetention(dailySeries(400));
    expect(plan.pruneStems.length).toBeGreaterThan(300);
    // 7 daily + 4 weekly + 12 monthly, minus the overlaps between tiers.
    expect(plan.keepStems.length).toBeGreaterThanOrEqual(12);
    expect(plan.keepStems.length).toBeLessThanOrEqual(
      RETENTION.daily + RETENTION.weekly + RETENTION.monthly,
    );
  });

  it("keeps one backup for each of the last 12 months", () => {
    // One backup on the 15th of each of 18 consecutive months.
    const objects: string[] = [];
    for (let m = 0; m < 18; m++) {
      objects.push(
        ...objectsFor(backupStem(new Date(Date.UTC(2025, 5 + m, 15, 3, 17, 0)))),
      );
    }
    const plan = planRetention(objects);
    const months = new Set(
      plan.keepStems.map((s) =>
        s.slice("cellar-atlas-".length, "cellar-atlas-".length + 7),
      ),
    );
    expect(months.size).toBeGreaterThanOrEqual(RETENTION.monthly);
  });

  it("spreads weekly retention across distinct ISO weeks, not every 7th file", () => {
    const plan = planRetention(dailySeries(90));
    const weeks = new Set(
      plan.keepStems
        .map((s) => parseBackupStem(s))
        .filter((d): d is Date => d !== null)
        .map((d) => {
          const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
          const isoDay = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
          t.setUTCDate(t.getUTCDate() + 4 - isoDay);
          return `${t.getUTCFullYear()}-${t.getUTCMonth()}-${t.getUTCDate()}`;
        }),
    );
    // Distinct weeks, not several files from the same week.
    expect(weeks.size).toBeGreaterThanOrEqual(RETENTION.weekly);
  });
});

describe("the refusals", () => {
  it("never prunes the newest backup, however old the series", () => {
    for (const days of [1, 10, 100, 1000]) {
      const plan = planRetention(dailySeries(days));
      expect(plan.pruneStems, `newest pruned in a ${days}-day series`).not.toContain(
        stemDaysAgo(0),
      );
      for (const name of objectsFor(stemDaysAgo(0))) {
        expect(plan.pruneObjects).not.toContain(name);
      }
    }
  });

  it("never produces an empty keep-set while any complete backup exists", () => {
    const cases = [dailySeries(1), objectsFor(stemDaysAgo(5000)), irregularHistory()];
    for (const objects of cases) {
      const plan = planRetention(objects);
      expect(plan.keepStems.length, "would keep nothing").toBeGreaterThan(0);
      expect(plan.pruneObjects.length).toBeLessThan(objects.length);
    }
  });

  it("reports an empty bucket rather than treating it as success", () => {
    const plan = planRetention([]);
    expect(plan.keepStems).toEqual([]);
    expect(plan.pruneObjects).toEqual([]);
    expect(plan.reason).toMatch(/no backups/i);
  });

  it("keep and prune together account for every complete set, with no overlap", () => {
    const plan = planRetention(dailySeries(200));
    expect(new Set([...plan.keepStems, ...plan.pruneStems]).size).toBe(200);
    for (const k of plan.keepStems) expect(plan.pruneStems).not.toContain(k);
  });

  /** A sparse, irregular history — the realistic shape after an outage. */
  function irregularHistory() {
    return [0, 1, 2, 9, 40, 95, 300, 700].map((d) => objectsFor(stemDaysAgo(d))).flat();
  }

  it("handles an irregular history without deleting the only copy of a period", () => {
    const plan = planRetention(irregularHistory());
    expect(plan.keepStems).toContain(stemDaysAgo(0));
    // Each of these is the sole backup for its month, so each is a monthly.
    expect(plan.pruneStems.length).toBeLessThanOrEqual(1);
  });
});

describe("the tests above are not vacuous", () => {
  it("a deliberately broken retention would be caught", () => {
    // Retention of zero in every tier: only the force-kept newest survives.
    const plan = planRetention(dailySeries(50), {
      retention: { daily: 0, weekly: 0, monthly: 0 },
    });
    expect(plan.keepStems).toEqual([stemDaysAgo(0)]);
  });

  it("a series built here really is recognised as complete sets", () => {
    // If objectsFor() ever drifted from expectedSuffixes(), every test above
    // would silently become a test of incomplete sets.
    const plan = planRetention(dailySeries(3));
    expect(plan.incompleteStems).toEqual([]);
    expect(plan.ignored).toEqual([]);
    expect(plan.keepStems.length).toBe(3);
  });
});
