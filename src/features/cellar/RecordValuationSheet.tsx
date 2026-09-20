import { useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";
import type { DomainBottle, DomainWine } from "@/domain/types";

/**
 * Record a valuation for a wine.
 *
 * ── WHY SCOPE MATTERS ────────────────────────────────────────────────────
 * Six identical bottles of the same wine share one market value. Valuing them
 * one at a time means entering the same number six times, which is how live
 * use found this.
 *
 * `record_valuation` already supported both shapes; only the UI forced the
 * per-bottle route:
 *
 *   wine_id   → applies the per-bottle amount to every ACTIVE bottle
 *   bottle_id → applies to that one bottle, overriding the wine-level figure
 *
 * ── THE AMOUNT IS PER BOTTLE ─────────────────────────────────────────────
 * Stated explicitly on the field, because "£450" against six bottles is
 * ambiguous and the wrong reading would be out by a factor of six. The form
 * also shows what the holding comes to, so the two cannot be confused.
 *
 * ── ONLY ACTIVE BOTTLES ──────────────────────────────────────────────────
 * "All N bottles" counts `isActive` only. A consumed bottle keeps its
 * historical value and is never revalued — the database enforces this too,
 * since the wine-level branch filters on `status = 'in_cellar'`.
 */

type Scope = "all" | "one";

const BASES = [
  { value: "market_estimate", label: "Market estimate" },
  { value: "merchant_retail", label: "Merchant retail" },
  { value: "auction_estimate", label: "Auction estimate" },
  { value: "realised_sale", label: "Realised sale" },
  { value: "manual_estimate", label: "My own estimate" },
] as const;

export type ValuationBasis = (typeof BASES)[number]["value"];

export interface ValuationSubmission {
  /** Set for a wine-level valuation. Mutually exclusive with bottleId. */
  wineId?: string;
  /** Set for a single-bottle valuation. */
  bottleId?: string;
  amount: number;
  basis: ValuationBasis;
  currency: string;
}

export function RecordValuationSheet({
  wine,
  activeBottles,
  defaultCurrency = "GBP",
  onCancel,
  onSubmit,
}: {
  wine: DomainWine;
  /** Active bottles only — the caller filters. */
  activeBottles: DomainBottle[];
  defaultCurrency?: string;
  onCancel: () => void;
  onSubmit: (v: ValuationSubmission) => Promise<{ ok: boolean; error?: string | null }>;
}) {
  const count = activeBottles.length;
  const isMulti = count > 1;

  // One bottle needs no scope question: there is only one answer.
  const [scope, setScope] = useState<Scope>("all");
  const [bottleId, setBottleId] = useState<string | null>(activeBottles[0]?.id ?? null);
  const [amount, setAmount] = useState("");
  const [basis, setBasis] = useState<ValuationBasis>("market_estimate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => {
    const n = Number(amount.trim());
    return amount.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
  }, [amount]);

  const appliesTo = !isMulti || scope === "all" ? count : 1;

  const submit = async () => {
    if (parsed === null) {
      setError("Enter a value per bottle.");
      return;
    }
    if (isMulti && scope === "one" && !bottleId) {
      setError("Choose which bottle this value is for.");
      return;
    }

    setBusy(true);
    setError(null);

    // A single active bottle records naturally against that bottle — no
    // scope decision, and no wine-level write that would be indistinguishable
    // from it anyway.
    const target =
      isMulti && scope === "all"
        ? { wineId: wine.id }
        : { bottleId: isMulti ? bottleId! : activeBottles[0]!.id };

    const result = await onSubmit({
      ...target,
      amount: parsed,
      basis,
      currency: defaultCurrency,
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Could not save. Your change is queued.");
    }
  };

  if (count === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <p
          style={{ color: "var(--text-secondary)", fontSize: "0.875rem", lineHeight: 1.6 }}
        >
          There are no bottles of this wine in the cellar to value.
        </p>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      {error && (
        <p role="alert" style={alertStyle}>
          {error}
        </p>
      )}

      {/* Scope — only asked when there is genuinely a choice. */}
      {isMulti && (
        <fieldset style={{ border: "none" }}>
          <legend style={legendStyle}>Apply this value to</legend>
          <div
            role="radiogroup"
            aria-label="Which bottles"
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            <button
              type="button"
              role="radio"
              aria-checked={scope === "all"}
              onClick={() => setScope("all")}
              style={optionStyle(scope === "all")}
            >
              <span style={{ display: "block" }}>All {count} bottles of this wine</span>
              <span style={hintStyle}>Every bottle currently in the cellar</span>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={scope === "one"}
              onClick={() => setScope("one")}
              style={optionStyle(scope === "one")}
            >
              <span style={{ display: "block" }}>One specific bottle</span>
              <span style={hintStyle}>For a bottle worth more or less than the rest</span>
            </button>
          </div>
        </fieldset>
      )}

      {isMulti && scope === "one" && (
        <fieldset style={{ border: "none" }}>
          <legend style={legendStyle}>Which bottle</legend>
          <div
            role="radiogroup"
            aria-label="Choose a bottle"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 200,
              overflowY: "auto",
            }}
          >
            {activeBottles.map((b, i) => (
              <button
                key={b.id}
                type="button"
                role="radio"
                aria-checked={bottleId === b.id}
                onClick={() => setBottleId(b.id)}
                style={{ ...optionStyle(bottleId === b.id), fontSize: "0.8125rem" }}
              >
                Bottle {i + 1}
                {b.positionKey ? ` · ${b.positionKey}` : ""}
                {b.bottleSize !== "750ml" ? ` · ${b.bottleSize}` : ""}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {/* The amount is PER BOTTLE, and the label says so. */}
      <Field
        label="Value per bottle"
        type="number"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        hint={`What one bottle is worth, not the total for all ${count}`}
      />

      {parsed !== null && appliesTo > 1 && (
        <p style={{ fontSize: "0.75rem", color: "var(--text-tertiary)", lineHeight: 1.6 }}>
          {money(parsed, defaultCurrency)} per bottle across {appliesTo} bottles
          {" — "}
          {money(parsed * appliesTo, defaultCurrency)} in total.
        </p>
      )}

      <fieldset style={{ border: "none" }}>
        <legend style={legendStyle}>Basis</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {BASES.map((b) => (
            <button
              key={b.value}
              type="button"
              role="radio"
              aria-checked={basis === b.value}
              onClick={() => setBasis(b.value)}
              style={chipStyle(basis === b.value)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Cancel
        </Button>
        <Button fullWidth disabled={busy || parsed === null} onClick={() => void submit()}>
          {busy ? "Saving…" : "Record valuation"}
        </Button>
      </div>
    </div>
  );
}

function money(amount: number, currency: string): string {
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

const legendStyle: React.CSSProperties = {
  fontSize: "0.6875rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  marginBottom: "0.5rem",
};

const hintStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.6875rem",
  color: "var(--text-tertiary)",
  marginTop: 2,
};

const optionStyle = (on: boolean): React.CSSProperties => ({
  width: "100%",
  textAlign: "left",
  minHeight: TOUCH_TARGET_MIN_PX,
  padding: "0.625rem 0.875rem",
  borderRadius: 10,
  background: on ? "rgba(217,174,85,0.12)" : "rgba(255,255,255,0.04)",
  border: `1px solid ${on ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"}`,
  color: on ? "var(--accent-gold)" : "var(--text-secondary)",
});

const chipStyle = (on: boolean): React.CSSProperties => ({
  minHeight: TOUCH_TARGET_MIN_PX - 8,
  padding: "0.5rem 0.875rem",
  borderRadius: 999,
  fontSize: "0.8125rem",
  background: on ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
  border: `1px solid ${on ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"}`,
  color: on ? "var(--accent-gold)" : "var(--text-secondary)",
});

const alertStyle: React.CSSProperties = {
  padding: "0.75rem 1rem",
  borderRadius: 10,
  background: "rgba(255,138,122,0.08)",
  border: "1px solid rgba(255,138,122,0.25)",
  color: "var(--status-past)",
  fontSize: "0.8125rem",
};
