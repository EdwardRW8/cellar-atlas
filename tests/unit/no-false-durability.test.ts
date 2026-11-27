import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOT_SAVED, OFFLINE_REASON } from "@/hooks/useCellar";

/**
 * THE APP MAY NOT PROMISE DURABILITY IT DOES NOT HAVE
 *
 * Phase 12.1 removed seven claims that a failed or offline change was kept —
 * "Your change is queued", "changes will sync", "saved on this device". None
 * was true: there is no queue, no cache of pending work, and nothing is
 * stored offline. A user who believed them would lose a change.
 *
 * This guard fails if any of that wording returns.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Code with comments stripped: prose explaining the ban must not trip it. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

const FILES = sourceFiles("src");

const BANNED: [string, RegExp][] = [
  ["change is queued", /\bis queued\b/i],
  ["changes will sync", /changes\s+will\s+sync/i],
  ["saved on this device", /saved\s+on\s+this\s+device/i],
  ["will sync when you reconnect", /will\s+sync\s+when/i],
  // Scoped to the durability context on purpose. The error boundaries say
  // "your bottles are listed below — nothing is lost", which is TRUE and not
  // a claim about a saved mutation.
  [
    "nothing is lost, about syncing",
    /(offline|sync|queued?)[\s\S]{0,200}?nothing\s+is\s+lost/i,
  ],
  ["we'll retry / will retry", /\bwill\s+retry\b/i],
  ["saved offline", /saved\s+offline/i],
];

describe("no user-facing text claims a change was kept", () => {
  it.each(BANNED)("never says %s", (_label, pattern) => {
    const offenders = FILES.filter((f) =>
      pattern.test(withoutComments(readFileSync(f, "utf8"))),
    );
    expect(offenders, `files containing ${pattern}`).toEqual([]);
  });

  it("the guard is not vacuous — it catches the exact wording that was removed", () => {
    const old = `<p>You are offline. Changes are saved on this device and will sync when you reconnect. Nothing is lost.</p>`;
    const caught = BANNED.filter(([, p]) => p.test(withoutComments(old)));
    expect(
      caught.length,
      "the old sentence must trip several rules",
    ).toBeGreaterThanOrEqual(3);
    expect(
      BANNED.some(([, p]) => p.test('setError("Could not save. Your change is queued.")')),
    ).toBe(true);
  });

  it("prose in a comment does not trip the guard", () => {
    const commented = `// previously said: changes will sync and nothing is lost\nconst x = 1;`;
    expect(BANNED.filter(([, p]) => p.test(withoutComments(commented)))).toEqual([]);
  });
});

describe("the replacement wording is honest", () => {
  it("says the change was NOT saved, with no promise of a retry", () => {
    expect(NOT_SAVED).toMatch(/not saved/i);
    expect(NOT_SAVED).toMatch(/nothing was recorded/i);
    for (const [, pattern] of BANNED) expect(NOT_SAVED).not.toMatch(pattern);
  });

  it("states that a connection is required, and claims nothing more", () => {
    expect(OFFLINE_REASON).toMatch(/offline/i);
    expect(OFFLINE_REASON).toMatch(/connection/i);
    for (const [, pattern] of BANNED) expect(OFFLINE_REASON).not.toMatch(pattern);
  });
});

describe("canMutate is connectivity AND permission, and says so", () => {
  const useCellar = readFileSync("src/hooks/useCellar.tsx", "utf8");

  it("FAILS CLOSED: only a confirmed owner or editor may write", () => {
    expect(useCellar).toMatch(
      /const canMutate =\s*\n?\s*online && permissionState === "known" && \(role === "owner" \|\| role === "editor"\);/,
    );
  });

  it("an unknown or failed role does NOT enable writes", () => {
    // SUPERSEDED: this previously asserted the opposite. Treating an unread
    // role as permission meant a blip during the permission check produced
    // write controls that could not work.
    expect(useCellar).not.toMatch(/const canMutate = online && role !== "viewer";/);
    expect(useCellar).toMatch(/permissionState === "known"/);
  });

  it("a failed permission check is recoverable, not terminal", () => {
    expect(useCellar).toMatch(/recheckPermission/);
    expect(useCellar).toMatch(/setPermissionState\("failed"\)/);
  });

  it("creating a FIRST cellar is gated separately from writing", () => {
    // A fresh account has no role, so a role-gated check would disable the
    // only action available to it.
    expect(useCellar).toMatch(
      /const canCreateCellar =\s*\n?\s*Boolean\(session\) && online && state === "no-cellar";/,
    );
  });

  it("no UI claims the backend is reachable or that saving will succeed", () => {
    for (const f of FILES) {
      const src = withoutComments(readFileSync(f, "utf8"));
      expect(src, f).not.toMatch(/will be saved\b/i);
      expect(src, f).not.toMatch(/connected to the server/i);
    }
  });
});
