// @vitest-environment jsdom

/**
 * THE APP MUST SAY WHICH THING IS WRONG, AND MUST NOT GUARANTEE WHAT IT
 * CANNOT KNOW.
 *
 * Two separate dishonesties are covered here, both found in audit of 12.1:
 *
 *   1. `canMutate` is one boolean standing for four situations — offline,
 *      view-only, permission check running, permission check failed — and
 *      every entry point rendered all four as "You're offline." An online
 *      viewer was told to check their connection. A failed permission check
 *      left the user read-only with nothing to click.
 *
 *   2. `NOT_SAVED` says "Nothing was recorded". That is knowable when the
 *      server answers no, and unknowable when the request never comes back:
 *      the mutation may have committed with only the response lost.
 *
 * These render the real components where behaviour is what matters, and test
 * the classifier directly where the cross-product is what matters.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  mutationBlock,
  mutationBlockMessage,
  mutationFailureMessage,
  MUTATION_BLOCK_MESSAGE,
  NOT_SAVED,
  NOT_CONFIRMED,
  OFFLINE_REASON,
  type PermissionState,
} from "@/domain/mutation-messaging";

let cellar: Record<string, unknown>;
vi.mock("@/hooks/useCellar", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/useCellar")>("@/hooks/useCellar");
  return { ...actual, useCellar: () => cellar };
});

const { MutationBlockedNotice } = await import("@/components/MutationBlockedNotice");

afterEach(cleanup);

const ONLINE = [true, false];
const STATES: PermissionState[] = ["unknown", "known", "failed"];
const ROLES = ["owner", "editor", "viewer", null];

/* ───────────────────────── 1. THE FOUR REASONS ───────────────────────── */

describe("a blocked control names the reason that actually applies", () => {
  it("never reports the wrong one of the four", () => {
    expect(mutationBlock({ online: false, permissionState: "known", role: "owner" })).toBe(
      "offline",
    );
    expect(mutationBlock({ online: true, permissionState: "failed", role: null })).toBe(
      "permission-failed",
    );
    expect(mutationBlock({ online: true, permissionState: "unknown", role: null })).toBe(
      "checking",
    );
    expect(mutationBlock({ online: true, permissionState: "known", role: "viewer" })).toBe(
      "read-only",
    );
    expect(
      mutationBlock({ online: true, permissionState: "known", role: "owner" }),
    ).toBeNull();
    expect(
      mutationBlock({ online: true, permissionState: "known", role: "editor" }),
    ).toBeNull();
  });

  /**
   * THE FINDING, STATED AS A TEST.
   *
   * Nothing about a viewer, or about a check in flight, or about a check that
   * failed, has anything to do with connectivity. Telling such a user they
   * are offline sends them to restart a router that is working.
   */
  it("NEVER tells an online user they are offline", () => {
    for (const permissionState of STATES) {
      for (const role of ROLES) {
        const message = mutationBlockMessage({ online: true, permissionState, role });
        if (message === null) continue;
        expect(
          message,
          `online/${permissionState}/${role} was told it is offline`,
        ).not.toMatch(/offline/i);
        expect(message).not.toBe(OFFLINE_REASON);
      }
    }
  });

  it("says offline only when actually offline — and then for every role", () => {
    for (const permissionState of STATES) {
      for (const role of ROLES) {
        expect(mutationBlockMessage({ online: false, permissionState, role })).toBe(
          OFFLINE_REASON,
        );
      }
    }
  });

  /**
   * Offline outranks a failed permission check on purpose: with no connection
   * the check cannot have succeeded and cannot be retried, so naming it would
   * point the user at the wrong problem and at a button that cannot work.
   */
  it("prefers offline over a permission failure, because retry needs a connection", () => {
    expect(mutationBlock({ online: false, permissionState: "failed", role: null })).toBe(
      "offline",
    );
  });

  /**
   * An unconfirmed role must never be described as view-only. That is the
   * same guess as the old fail-open bug, pointing the other way: it would
   * tell an owner they are a viewer.
   */
  it("does not call an unconfirmed role view-only", () => {
    for (const permissionState of ["unknown", "failed"] as PermissionState[]) {
      const message = mutationBlockMessage({ online: true, permissionState, role: null });
      expect(message).not.toBe(MUTATION_BLOCK_MESSAGE["read-only"]);
      expect(message).not.toMatch(/view-only/i);
    }
  });

  /**
   * The classifier and the gate must agree on every input. If they drift, a
   * control is either disabled with no explanation, or explained while still
   * enabled — and one of the two is a lie.
   */
  it("agrees with canMutate across the whole cross-product", () => {
    for (const online of ONLINE) {
      for (const permissionState of STATES) {
        for (const role of ROLES) {
          const canMutate =
            online &&
            permissionState === "known" &&
            (role === "owner" || role === "editor");
          const blocked = mutationBlock({ online, permissionState, role }) !== null;
          expect(
            blocked,
            `${online}/${permissionState}/${role}: canMutate=${canMutate} blocked=${blocked}`,
          ).toBe(!canMutate);
        }
      }
    }
  });

  it("every reason has distinct wording — four reasons, four sentences", () => {
    const messages = Object.values(MUTATION_BLOCK_MESSAGE);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

/* ────────────── 2. A FAILED PERMISSION CHECK IS RECOVERABLE ────────────── */

function setCellar(over: Record<string, unknown> = {}) {
  cellar = {
    online: true,
    permissionState: "known",
    role: "owner",
    recheckPermission: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  return cellar;
}

describe("a failed permission check is surfaced, with a working Retry", () => {
  it("says so, and offers Retry wired to recheckPermission", async () => {
    const c = setCellar({ permissionState: "failed", role: null });
    render(<MutationBlockedNotice />);

    expect(screen.getByRole("status").textContent).toContain(
      MUTATION_BLOCK_MESSAGE["permission-failed"],
    );

    const retry = screen.getByRole("button", { name: /retry/i });
    expect(retry).toBeTruthy();

    fireEvent.click(retry);
    await waitFor(() => expect(c.recheckPermission).toHaveBeenCalledTimes(1));
  });

  it("the message explains that changes are off, without blaming the network", () => {
    setCellar({ permissionState: "failed", role: null });
    render(<MutationBlockedNotice />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/couldn't check|could not check/i);
    expect(text).not.toMatch(/offline|connection/i);
  });

  it("disappears once the recheck succeeds", () => {
    setCellar({ permissionState: "failed", role: null });
    const { rerender } = render(<MutationBlockedNotice />);
    expect(screen.queryByRole("status")).toBeTruthy();

    // What recheckPermission does on success: role known, state known.
    setCellar({ permissionState: "known", role: "owner" });
    rerender(<MutationBlockedNotice />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  /**
   * Retry is offered for exactly one reason, because it is the only one it
   * can clear. A button that cannot work is its own small lie.
   */
  it("offers Retry for a failed check and for nothing else", () => {
    const cases: [Record<string, unknown>, boolean][] = [
      [{ permissionState: "failed", role: null }, true],
      [{ permissionState: "unknown", role: null }, false],
      [{ permissionState: "known", role: "viewer" }, false],
      [{ online: false, permissionState: "known", role: "owner" }, false],
    ];
    for (const [over, expected] of cases) {
      cleanup();
      setCellar(over);
      render(<MutationBlockedNotice />);
      expect(
        screen.queryAllByRole("button", { name: /retry/i }).length > 0,
        `${JSON.stringify(over)} should ${expected ? "" : "not "}offer Retry`,
      ).toBe(expected);
    }
  });

  it("renders nothing at all when a change may be attempted", () => {
    setCellar();
    render(<MutationBlockedNotice />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("tells an online viewer the truth, and offers them no retry", () => {
    setCellar({ permissionState: "known", role: "viewer" });
    render(<MutationBlockedNotice />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/view-only/i);
    expect(text).not.toMatch(/offline/i);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});

/* ──────────── 3. AN UNCONFIRMED MUTATION IS NOT A FAILED ONE ──────────── */

describe("a lost response is never reported as a guaranteed non-write", () => {
  const AMBIGUOUS = [
    "Failed to fetch",
    "TypeError: NetworkError when attempting to fetch resource",
    "timeout of 30000ms exceeded",
    "ECONNRESET",
    "The server is unreachable",
    "network request failed",
  ];

  it.each(AMBIGUOUS)("does not claim nothing was recorded after %s", (error) => {
    const message = mutationFailureMessage(error);
    expect(message).toBe(NOT_CONFIRMED);
    expect(message).not.toMatch(/nothing was recorded/i);
    expect(message).not.toBe(NOT_SAVED);
  });

  /**
   * The server answering no IS a definite outcome, and its own words are more
   * useful than any generic sentence. That path must not be swept into the
   * cautious message, or every rejection would tell the user to go and check
   * something that cannot have happened.
   */
  it.each([
    "That position is already occupied",
    "new row violates row-level security policy",
    "version mismatch",
  ])("reports a real rejection in the server's own words: %s", (error) => {
    expect(mutationFailureMessage(error)).toBe(error);
  });

  it("falls back to NOT_SAVED only when there is no error detail", () => {
    expect(mutationFailureMessage(undefined)).toBe(NOT_SAVED);
    expect(mutationFailureMessage(null)).toBe(NOT_SAVED);
    expect(mutationFailureMessage("")).toBe(NOT_SAVED);
  });

  it("NOT_CONFIRMED states the uncertainty and says to check first", () => {
    expect(NOT_CONFIRMED).toMatch(/don't know|do not know/i);
    expect(NOT_CONFIRMED).toMatch(/refresh|check/i);
    expect(NOT_CONFIRMED).not.toMatch(/nothing was recorded/i);
    expect(NOT_CONFIRMED).not.toMatch(/\bnot saved\b/i);
  });

  /**
   * It must not promise retry safety either. A replay IS harmless when the
   * operation id is stable, but the test below proves that ordinary screens
   * do not supply one.
   */
  it("NOT_CONFIRMED promises nothing about retrying", () => {
    expect(NOT_CONFIRMED).not.toMatch(
      /safe to (try|retry)|won't duplicate|will not duplicate|no duplicate|only once/i,
    );
    expect(NOT_CONFIRMED).not.toMatch(/\bwill retry\b|\bis queued\b/i);
  });

  it("NOT_SAVED keeps its definite wording, for the case where it is true", () => {
    expect(NOT_SAVED).toMatch(/not saved/i);
    expect(NOT_SAVED).toMatch(/nothing was recorded/i);
  });
});

/* ───── 4. THE EVIDENCE BEHIND THAT CAUTION, AND THE IDEMPOTENCY KEPT ───── */

describe("operation-id idempotency is preserved where it exists, and not claimed where it does not", () => {
  const repo = readFileSync("src/data/repositories/mutation-repository.ts", "utf8");

  /**
   * WHY NOT_CONFIRMED CANNOT PROMISE A SAFE RETRY.
   *
   * `claim_operation` makes a replay harmless only when the SAME operation id
   * comes back. These methods mint a fresh one per call, so a second press is
   * a second operation the server cannot match to the first. If that ever
   * changes, this test fails and the message can be made more generous.
   */
  it.each([
    "commitDraft",
    "updateWine",
    "moveBottle",
    "correctBottle",
    "upsertProfile",
    "createLocation",
  ])("%s generates a fresh operation id per call", (method) => {
    const body = repo.slice(repo.indexOf(`${method}(`));
    const opLine = body.slice(0, body.indexOf("const opId") + 60);
    expect(body.indexOf("const opId"), `${method} has no opId`).toBeGreaterThan(-1);
    expect(opLine).toMatch(/const (opId|wineOp) = newId\(\)/);
    expect(opLine).not.toMatch(/args\.operationId/);
  });

  /**
   * The importer's guarantee must survive this change untouched: it is the
   * one path that DOES hold stable ids across a retry.
   */
  it.each(["changeStatus", "recordTasting", "recordValuation"])(
    "%s still accepts a caller-supplied operation id",
    (method) => {
      const body = repo.slice(repo.indexOf(`${method}(args: {`));
      expect(body.slice(0, body.indexOf("const opId") + 60)).toMatch(
        /const opId = args\.operationId \?\? newId\(\)/,
      );
    },
  );

  it("the importer still passes its deterministic ids", () => {
    const importer = readFileSync("src/features/import/ImportScreen.tsx", "utf8");
    expect(importer).toMatch(/operationId: g\.operationId/);
    expect(importer).toMatch(/operationId: v\.operationId/);
    expect(importer).toMatch(/operationId: t\.operationId/);
  });
});

/* ──────────────── 5. THE CORRECTIONS CANNOT SILENTLY RETURN ──────────────── */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe("no entry point goes back to explaining everything as offline", () => {
  const FILES = sourceFiles("src");

  it("no file renders OFFLINE_REASON as the reason a control is disabled", () => {
    const pattern = /!canMutate[\s\S]{0,24}?\?\s*OFFLINE_REASON/;
    const offenders = FILES.filter((f) => pattern.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the guard is not vacuous — it catches the wording that was removed", () => {
    const old = `{busy ? "Saving…" : !canMutate ? OFFLINE_REASON : "Save profile"}`;
    const wrapped = `{submitting
              ? "Saving…"
              : !canMutate
                ? OFFLINE_REASON
                : "Add"}`;
    const pattern = /!canMutate[\s\S]{0,24}?\?\s*OFFLINE_REASON/;
    expect(pattern.test(old)).toBe(true);
    expect(pattern.test(wrapped)).toBe(true);
  });

  /**
   * CORRECTION 3. The old comment said an unknown role "is treated as
   * permitted". The code it described was replaced by a fail-closed gate, so
   * the comment asserted the exact opposite of the behaviour — the most
   * dangerous kind of stale comment, since the next reader trusts it.
   */
  it("useCellar no longer claims an unknown permission is permitted", () => {
    const s = readFileSync("src/hooks/useCellar.tsx", "utf8");
    expect(s).not.toMatch(/treated as permitted/i);
    expect(s).not.toMatch(/leaves the role unknown,\s*\n?\s*\/\/\s*which is treated/i);
    // And the fail-closed behaviour it contradicted is still there.
    expect(s).toMatch(/permissionState === "known"/);
  });

  it("recheckPermission is actually reachable from the UI, not just exported", () => {
    const consumers = FILES.filter((f) =>
      /recheckPermission/.test(readFileSync(f, "utf8")),
    );
    // The provider itself, plus at least one component that renders a retry.
    expect(consumers.length).toBeGreaterThan(1);
    expect(consumers.some((f) => !f.includes("hooks/useCellar"))).toBe(true);
  });

  it("the global status bar surfaces a failed permission check", () => {
    const s = readFileSync("src/features/sync/SyncStatusBar.tsx", "utf8");
    expect(s).toMatch(/permission-failed/);
    expect(s).toMatch(/MutationBlockedNotice/);
  });
});
