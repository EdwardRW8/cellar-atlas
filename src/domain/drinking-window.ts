/**
 * Drinking window.
 *
 * Seven deterministic states, computed from the window and the current year.
 * Pure and testable — the intelligence features in Phase 8 depend on this
 * being verifiable rather than a judgement call buried in a component.
 *
 * The rack still shows three colours. A richer model underneath does not
 * mean a busier rack.
 */

export type WindowState =
  "unknown" | "veryYoung" | "approaching" | "ready" | "peak" | "lateWindow" | "pastWindow";

export interface DrinkingWindow {
  from: number | null;
  until: number | null;
}

/** The three colours the rack shows. */
export type WindowIndicator = "ready" | "young" | "past" | "unknown";

export interface WindowAssessment {
  state: WindowState;
  indicator: WindowIndicator;
  /** Negative = years until it opens. Positive = years since it closed. */
  yearsToOpen: number | null;
  yearsToClose: number | null;
  /** 0–1 through the window. Null when it cannot be computed. */
  progress: number | null;
  label: string;
}

const VERY_YOUNG_THRESHOLD = 3; // more than 3 years before opening
const LATE_WINDOW_FRACTION = 0.75; // last quarter of the window

export function assessWindow(
  window: DrinkingWindow,
  currentYear: number = new Date().getFullYear(),
): WindowAssessment {
  const { from, until } = window;

  // Unknown: not an error, just an absence. Common for gifts and older stock.
  if (from === null && until === null) {
    return {
      state: "unknown",
      indicator: "unknown",
      yearsToOpen: null,
      yearsToClose: null,
      progress: null,
      label: "Drinking window unknown",
    };
  }

  const yearsToOpen = from !== null ? from - currentYear : null;
  const yearsToClose = until !== null ? until - currentYear : null;

  // Past the close date.
  if (until !== null && currentYear > until) {
    return {
      state: "pastWindow",
      indicator: "past",
      yearsToOpen,
      yearsToClose,
      progress: 1,
      label: `Past window since ${until}`,
    };
  }

  // Before the open date.
  if (from !== null && currentYear < from) {
    const away = from - currentYear;
    return {
      state: away > VERY_YOUNG_THRESHOLD ? "veryYoung" : "approaching",
      indicator: "young",
      yearsToOpen,
      yearsToClose,
      progress: 0,
      label:
        away > VERY_YOUNG_THRESHOLD
          ? `Very young — opens ${from}`
          : `Approaching — opens ${from}`,
    };
  }

  // Inside the window, or open-ended.
  if (from !== null && until !== null) {
    const span = until - from;
    const elapsed = currentYear - from;
    const progress = span <= 0 ? 1 : elapsed / span;

    if (progress >= LATE_WINDOW_FRACTION) {
      return {
        state: "lateWindow",
        indicator: "ready",
        yearsToOpen,
        yearsToClose,
        progress: Math.min(1, progress),
        label: `Late window — drink by ${until}`,
      };
    }
    return {
      state: progress >= 0.25 ? "peak" : "ready",
      indicator: "ready",
      yearsToOpen,
      yearsToClose,
      progress,
      label: progress >= 0.25 ? "At peak" : "Ready to drink",
    };
  }

  // Only one bound known.
  if (from !== null && until === null) {
    return {
      state: "ready",
      indicator: "ready",
      yearsToOpen,
      yearsToClose: null,
      progress: null,
      label: `Ready since ${from}`,
    };
  }

  return {
    state: "ready",
    indicator: "ready",
    yearsToOpen: null,
    yearsToClose,
    progress: null,
    label: until !== null ? `Drink by ${until}` : "Ready to drink",
  };
}

/** Is this bottle drinkable now? Used by pairings and Home. */
export function isReadyNow(window: DrinkingWindow, currentYear?: number): boolean {
  const { indicator } = assessWindow(window, currentYear);
  return indicator === "ready";
}

/**
 * Bottles that should ideally be drunk within `years`.
 * The basis for Drinking Pressure in Phase 8.
 */
export function closesWithin(
  window: DrinkingWindow,
  years: number,
  currentYear: number = new Date().getFullYear(),
): boolean {
  if (window.until === null) return false;
  const remaining = window.until - currentYear;
  return remaining >= 0 && remaining <= years;
}
