import { describe, it, expect } from "vitest";
import {
  text,
  surface,
  status,
  accent,
  feedback,
  contrastRatio,
  WCAG_AA_NORMAL,
  WCAG_AA_LARGE,
  TOUCH_TARGET_MIN_PX,
} from "@/styles/tokens";

/**
 * This test guards the accessibility failure that shipped in V2, where five
 * text colours sat between 1.19:1 and 3.01:1 against a near-black background.
 * If a future change reintroduces an unreadable content colour, the BUILD
 * FAILS rather than the user squinting at it.
 */
describe("content colours meet WCAG AA", () => {
  const backgrounds = [
    ["base", surface.base],
    ["raised", surface.raised],
    ["overlay", surface.overlay],
  ] as const;

  for (const [bgName, bg] of backgrounds) {
    for (const [name, colour] of Object.entries(text)) {
      if (name === "inverse") continue; // used only on light/gold backgrounds
      it(`text.${name} on surface.${bgName} >= ${WCAG_AA_NORMAL}:1`, () => {
        const ratio = contrastRatio(colour, bg);
        expect(
          ratio,
          `text.${name} (${colour}) on ${bg} was ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
      });
    }
  }

  it("text.inverse is readable on the gold accent", () => {
    expect(contrastRatio(text.inverse, accent.gold)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });
});

describe("status colours are legible", () => {
  for (const [name, colour] of Object.entries(status)) {
    it(`status.${name} >= ${WCAG_AA_NORMAL}:1 on base`, () => {
      const ratio = contrastRatio(colour, surface.base);
      expect(ratio, `status.${name} was ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL,
      );
    });
  }

  for (const [name, colour] of Object.entries(feedback)) {
    it(`feedback.${name} >= ${WCAG_AA_LARGE}:1 on raised`, () => {
      expect(contrastRatio(colour, surface.raised)).toBeGreaterThanOrEqual(WCAG_AA_LARGE);
    });
  }
});

describe("V2 regression — the colours that failed must not return", () => {
  const banned = {
    "#2a1a0e": "V2 metadata labels — measured 1.19:1",
    "#3a2a1a": "V2 muted text — measured 1.45:1",
    "#4a3a2a": "V2 secondary text — measured 1.83:1",
    "#5a4a3a": "V2 form labels — measured 2.35:1",
    "#6a5a4a": "V2 ghost button text — measured 3.01:1",
  };

  for (const [hex, why] of Object.entries(banned)) {
    it(`${hex} is not used as a content colour (${why})`, () => {
      const contentColours = Object.values(text).map((c) => c.toLowerCase());
      expect(contentColours).not.toContain(hex.toLowerCase());
      // And prove why: it would fail the standard anyway.
      expect(contrastRatio(hex, surface.base)).toBeLessThan(WCAG_AA_NORMAL);
    });
  }
});

describe("touch targets", () => {
  it("minimum is at least 44px per WCAG 2.5.5 and Apple HIG", () => {
    expect(TOUCH_TARGET_MIN_PX).toBeGreaterThanOrEqual(44);
  });
});
