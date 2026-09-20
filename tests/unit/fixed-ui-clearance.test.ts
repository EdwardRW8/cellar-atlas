/**
 * FIXED BOTTOM UI CLEARANCE
 *
 * Two elements float over scrollable content on mobile:
 *
 *   bottom navigation   0px  →  ~60px
 *   Add Wine button    76px  →  132px
 *
 * The shell previously reserved 4.5rem (72px), which cleared the navigation
 * but not the button. The last ~60px of every screen was therefore covered
 * and untappable — Playwright reported the Add Wine button intercepting
 * pointer events on the rack's "Face on" control.
 *
 * The clearance is now derived from the button's own geometry, and these
 * tests assert the arithmetic so the two cannot drift apart again.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TOUCH_TARGET_MIN_PX,
  ADD_BUTTON_OFFSET_REM,
  ADD_BUTTON_SIZE_PX,
  FIXED_UI_CLEARANCE_REM,
} from "@/styles/tokens";

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const REM = 16;

describe("the clearance actually clears the fixed UI", () => {
  it("the Add Wine button's top edge is where we think it is", () => {
    const topEdge = ADD_BUTTON_OFFSET_REM * REM + ADD_BUTTON_SIZE_PX;
    expect(topEdge).toBe(132);
  });

  it("CLEARANCE EXCEEDS THE BUTTON — the actual bug", () => {
    const clearance = FIXED_UI_CLEARANCE_REM * REM;
    const buttonTop = ADD_BUTTON_OFFSET_REM * REM + ADD_BUTTON_SIZE_PX;
    expect(clearance).toBeGreaterThan(buttonTop);
  });

  it("the old 4.5rem value would NOT have cleared it", () => {
    const old = 4.5 * REM;
    const buttonTop = ADD_BUTTON_OFFSET_REM * REM + ADD_BUTTON_SIZE_PX;
    expect(old).toBeLessThan(buttonTop); // 72 < 132 — this was the fault
  });

  it("leaves a visible margin, not a hairline", () => {
    const margin =
      FIXED_UI_CLEARANCE_REM * REM - (ADD_BUTTON_OFFSET_REM * REM + ADD_BUTTON_SIZE_PX);
    expect(margin).toBeGreaterThanOrEqual(8);
  });

  it("the button still meets the 44px touch target", () => {
    expect(ADD_BUTTON_SIZE_PX).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
  });
});

describe("the shell reserves the clearance", () => {
  const shell = read("src/app/layout/AppShell.tsx");

  it("mobile reserves the derived clearance plus the safe area", () => {
    expect(shell).toMatch(
      /paddingBottom: `calc\(\$\{FIXED_UI_CLEARANCE_REM\}rem \+ var\(--safe-bottom\)\)`/,
    );
  });

  it("no hard-coded 4.5rem remains", () => {
    expect(shell).not.toMatch(/4\.5rem/);
  });

  it("desktop also reserves room — the button floats there too", () => {
    expect(shell).toMatch(/paddingBottom: `\$\{FIXED_UI_CLEARANCE_REM\}rem`/);
  });

  it("desktop keeps its existing padding otherwise", () => {
    expect(shell).toMatch(/padding: "1\.5rem"/);
    expect(shell).toMatch(/maxWidth: 1100/);
  });
});

describe("the button derives its geometry from the same tokens", () => {
  const router = read("src/app/router.tsx");

  it("uses the offset token, not a literal", () => {
    expect(router).toMatch(/\$\{ADD_BUTTON_OFFSET_REM\}rem/);
    expect(router).not.toMatch(/4\.75rem/);
  });

  it("uses the size token, not a literal", () => {
    expect(router).toMatch(/minHeight: ADD_BUTTON_SIZE_PX/);
    expect(router).toMatch(/minWidth: ADD_BUTTON_SIZE_PX/);
  });

  it("the Add Wine button still exists and is labelled", () => {
    expect(router).toMatch(/aria-label="Add wine"/);
    expect(router).toMatch(/position: "fixed"/);
  });

  it("sits below the navigation in stacking order", () => {
    const nav = read("src/app/layout/BottomNav.tsx");
    expect(router).toMatch(/zIndex: 95/);
    expect(nav).toMatch(/zIndex: 100/);
  });
});

describe("bottom navigation is unchanged", () => {
  const nav = read("src/app/layout/BottomNav.tsx");

  it("is still fixed to the bottom with its safe area", () => {
    expect(nav).toMatch(/position: "fixed"/);
    expect(nav).toMatch(/bottom: 0/);
    expect(nav).toMatch(/paddingBottom: "var\(--safe-bottom\)"/);
  });

  it("still meets the touch target", () => {
    expect(nav).toMatch(/minHeight: TOUCH_TARGET_MIN_PX \+ 8/);
  });
});

describe("the rack control row keeps its own margin", () => {
  it("is not flush against the reserved zone", () => {
    expect(read("src/features/storage/rack/RackRenderer.tsx")).toMatch(
      /marginBottom: "0\.5rem"/,
    );
  });

  it("Face on still meets the 44px target", () => {
    expect(read("src/features/storage/rack/RackRenderer.tsx")).toMatch(/minHeight: 44/);
  });
});
