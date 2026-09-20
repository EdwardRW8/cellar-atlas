import type { MoneyTotals } from "@/domain/valuation";

/**
 * A valuation total that cannot lie.
 *
 * Three states, and only three:
 *
 *   nothing valued   → says so; no figure at all, never £0
 *   one currency     → the amount, with completeness when partial
 *   mixed currencies → per-currency amounts, NEVER summed
 *
 * There is no exchange rate in this application, so a combined figure across
 * currencies would represent nothing real. The component has no code path
 * that produces one.
 */
export function ValuationTotal({
  totals,
  noun = "valued",
  inline = false,
}: {
  totals: MoneyTotals;
  noun?: string;
  /** Render as a run-on fragment rather than a block. */
  inline?: boolean;
}) {
  if (totals.present === 0) return null;

  const caption = totals.absent > 0 ? `${totals.present} of ${totals.total} ${noun}` : null;

  // ── Mixed: per-currency only ──
  if (totals.isMixed) {
    return (
      <span
        style={inline ? undefined : blockStyle}
        aria-label="Mixed currencies, not combined"
      >
        <span style={{ color: "var(--text-primary)" }}>
          {totals.byCurrency.map((c) => money(c.amount, c.currency)).join(" · ")}
        </span>
        <span style={captionStyle}>
          {" "}
          (mixed currencies, not combined
          {caption ? `; ${caption}` : ""})
        </span>
      </span>
    );
  }

  // ── Single currency ──
  const only = totals.single!;
  return (
    <span style={inline ? undefined : blockStyle}>
      <span style={{ color: "var(--text-primary)" }}>
        {money(only.amount, only.currency)}
      </span>
      {caption && <span style={captionStyle}> ({caption})</span>}
    </span>
  );
}

/** Formats in the given currency. Never converts between them. */
export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount)}`;
  }
}

const blockStyle: React.CSSProperties = { display: "inline" };

const captionStyle: React.CSSProperties = {
  color: "var(--text-tertiary)",
  fontSize: "0.75em",
};
