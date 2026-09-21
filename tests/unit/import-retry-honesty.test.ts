import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE RETRY PROMISE MUST BE TRUE
 *
 * Writing the Phase 11 E2E exposed that the completion screen told users:
 *
 *   "Importing the same file again will retry only what failed.
 *    Nothing that already succeeded will be created twice."
 *
 * That was false. Every upload mints `attemptId = crypto.randomUUID()`, and
 * every operation id is derived from it — so a re-upload has entirely new
 * operation ids and `claim_operation` treats each step as new work. On a
 * 73-row import, following that advice after a partial failure would have
 * duplicated the collection.
 *
 * These tests pin the corrected behaviour. They read source because the
 * guarantee is structural: it holds only while the original plan exists.
 */

const SRC = readFileSync(
  join(process.cwd(), "src/features/import/ImportScreen.tsx"),
  "utf8",
);

describe("REGRESSION: the false re-import promise is gone", () => {
  it("never tells the user re-importing the file is safe", () => {
    expect(SRC).not.toMatch(/Importing the same\s+file again will retry only what failed/);
  });

  it("warns plainly that re-importing would duplicate", () => {
    // Whitespace-tolerant: Prettier reflows long JSX text across lines.
    expect(SRC).toMatch(
      /Importing the same\s+file again would add every bottle a second time/,
    );
  });

  it("warns that leaving the screen ends the attempt", () => {
    expect(SRC).toMatch(/If you leave this screen,\s+this attempt cannot be resumed/);
  });
});

describe("why re-uploading is NOT a retry", () => {
  it("each upload mints a fresh, random attempt id", () => {
    // This is correct — a deliberate later import must be possible — but it
    // is precisely why a re-upload cannot be a retry.
    expect(SRC).toMatch(/const attemptId = crypto\.randomUUID\(\)/);
  });

  it("the attempt id lives only in component state, not persistently", () => {
    expect(SRC).not.toMatch(/localStorage\.setItem\([^)]*attempt/i);
    expect(SRC).not.toMatch(/sessionStorage\.setItem\([^)]*attempt/i);
  });
});

describe("the real retry path: same plan, same operation ids", () => {
  it("offers an explicit Retry that re-runs the SAME plan", () => {
    expect(SRC).toMatch(/Retry failed steps/);
    expect(SRC).toMatch(/onRetry=\{\(\) => void execute\(\)\}/);
  });

  it("every mutation takes its operation id from the plan", () => {
    expect(SRC).toMatch(/operationId: w\.operationId/);
    // One id PER ACQUISITION GROUP now. The groups are computed with the plan
    // and held in state beside it, so Retry reuses the very same ids.
    expect(SRC).toMatch(/operationId: g\.operationId/);
    expect(SRC).toMatch(/setGroups\(\s*await planAcquisitions\(/);
    expect(SRC).toMatch(/operationId: v\.operationId/);
    expect(SRC).toMatch(/operationId: t\.operationId/);
  });

  it("wine ids are read back from the replayed result, not re-minted", () => {
    // On replay `create_wine_definition` returns the ORIGINAL id.
    expect(SRC).toMatch(/wineIds\.set\(w\.key, outcome\.entityId\)/);
  });
});

describe("double-click cannot start two imports", () => {
  it("guards re-entry at the source", () => {
    expect(SRC).toMatch(/if \(running\.current\) return;/);
    expect(SRC).toMatch(/running\.current = true;/);
  });

  it("ALWAYS releases the guard, even when the import throws", () => {
    // Without this, one thrown error would leave Retry permanently inert.
    const execute = SRC.slice(
      SRC.indexOf("const execute = async"),
      SRC.indexOf("const executeSteps = async"),
    );
    expect(execute).toMatch(/finally \{/);
    expect(execute).toMatch(/running\.current = false;/);
  });

  it("a thrown error is surfaced, not swallowed", () => {
    const execute = SRC.slice(
      SRC.indexOf("const execute = async"),
      SRC.indexOf("const executeSteps = async"),
    );
    expect(execute).toMatch(/catch \(e\)/);
    expect(execute).toMatch(/setError\(/);
  });
});
