/**
 * Design tokens — the single source of visual truth.
 *
 * Every colour used for CONTENT is contrast-tested against its intended
 * background in tests/unit/tokens.contrast.test.ts. That test FAILS THE BUILD
 * if any content token drops below WCAG AA (4.5:1).
 *
 * V2 shipped five text colours between 1.19:1 and 3.01:1 — effectively
 * invisible. Very dark browns are still used here, but only for borders,
 * dividers and surfaces, where contrast is irrelevant.
 */

export const surface = {
  base: "#0A0705",
  raised: "#120D08",
  overlay: "#181109",
  sunken: "#060403",
} as const;

export const border = {
  subtle: "#241A12",
  strong: "#3A2A1C",
  accent: "rgba(217,174,85,0.28)",
} as const;

/** Content colours. All are contrast-tested. */
export const text = {
  /** 16.9:1 on base — headings, wine names, primary values */
  primary: "#F5EFE4",
  /** 9.4:1 on base — body copy, descriptions */
  secondary: "#C9BCA8",
  /** 5.2:1 on base — labels, metadata. LOWEST PERMITTED for content. */
  tertiary: "#9C8E7A",
  /** 9.5:1 on base — accent, links, emphasis */
  accent: "#D9AE55",
  /** For use on gold/light backgrounds only */
  inverse: "#0A0705",
} as const;

export const accent = {
  gold: "#D9AE55",
  goldMuted: "#A8823C",
  goldGradient: "linear-gradient(135deg,#8B5E2C,#D9AE55)",
} as const;

/**
 * Drinking-window status. Softer and higher contrast than V2's saturated
 * greens/ambers/reds, which fought with the near-black background.
 */
export const status = {
  ready: "#6EE7A0",
  approaching: "#F5B544",
  past: "#FF8A7A",
  unknown: "#9C8E7A",
} as const;

/** Wine colours for rack bottles and category markers. */
export const wine = {
  Red: "#9B3141",
  White: "#D6B658",
  Sparkling: "#C4B478",
  Rose: "#D98BA0",
  Dessert: "#B8912F",
  Fortified: "#8B4A3A",
  Unknown: "#7A6A5A",
} as const;

export const feedback = {
  success: "#6EE7A0",
  warning: "#F5B544",
  danger: "#FF8A7A",
  info: "#8FBFD9",
} as const;

export const font = {
  display: "'Cormorant Garamond', Georgia, serif",
  body: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
} as const;

export const size = {
  xs: "0.6875rem",
  sm: "0.8125rem",
  base: "0.9375rem",
  lg: "1.0625rem",
  xl: "1.25rem",
  "2xl": "1.5rem",
  "3xl": "1.875rem",
  "4xl": "2.5rem",
} as const;

export const space = {
  xs: "0.25rem",
  sm: "0.5rem",
  md: "0.75rem",
  lg: "1rem",
  xl: "1.5rem",
  "2xl": "2rem",
  "3xl": "3rem",
} as const;

export const radius = {
  sm: "6px",
  md: "10px",
  lg: "14px",
  xl: "20px",
  full: "9999px",
} as const;

/** Minimum touch target — WCAG 2.5.5 / Apple HIG. Enforced in tests. */
export const TOUCH_TARGET_MIN_PX = 44;

export const motion = {
  fast: "120ms cubic-bezier(0.4,0,0.2,1)",
  base: "200ms cubic-bezier(0.4,0,0.2,1)",
  slow: "320ms cubic-bezier(0.4,0,0.2,1)",
} as const;

export const z = {
  base: 0,
  nav: 100,
  sheet: 200,
  modal: 300,
  toast: 400,
} as const;

// ── Contrast utilities (used by the test that guards these tokens) ─────────

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export const WCAG_AA_NORMAL = 4.5;
export const WCAG_AA_LARGE = 3.0;
