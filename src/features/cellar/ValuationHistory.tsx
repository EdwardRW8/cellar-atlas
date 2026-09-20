import { useCallback, useEffect, useMemo, useState } from "react";
import { useCellar } from "@/hooks/useCellar";
import {
  holdingValuation,
  describeCompleteness,
  isPartial,
  type MoneyTotals,
  type HoldingGain,
} from "@/domain/valuation";
import { Skeleton } from "@/components/Skeleton";
import { Button } from "@/components/Button";
import type { DomainBottle } from "@/domain/types";

/**
 * Valuation for one wine: what it cost, what it is worth, and the ledger.
 *
 * ── NOTHING HERE IS EVER ZERO-FILLED ─────────────────────────────────────
 * A bottle with no valuation is counted as unvalued, never as £0. Every
 * monetary figure carries the count it covers, so "£1,680" can never be read
 * as a complete holding when it is really 11 bottles out of 14.
 *
 * ── CURRENCIES ARE NEVER COMBINED ────────────────────────────────────────
 * There is no exchange rate in this application. A holding costed in EUR and
 * valued in GBP has no single gain, and the UI says so rather than inventing
 * one.
 */

interface LedgerEntry {
  id: string;
  amount: number;
  currency: string;
  valuationBasis: string;
  source: string;
  valuedOn: string;
  bottleId: string | null;
}

const BASIS_LABELS: Record<string, string> = {
  purchase_price: "Purchase price",
  market_estimate: "Market estimate",
  auction_estimate: "Auction estimate",
  realised_sale: "Realised sale",
  insurance_value: "Insurance value",
  manual_estimate: "Manual estimate",
};

const SOURCE_LABELS: Record<string, string> = {
  manual: "entered by hand",
  merchant: "from a merchant",
  auction_house: "from an auction house",
  market_data: "from market data",
  import: "imported",
};

/** A realised sale is a fact; an estimate is an opinion. Show the difference. */
function isFact(basis: string): boolean {
  return basis === "realised_sale" || basis === "purchase_price";
}

export function ValuationHistory({
  wineId,
  bottles,
  onRecordValuation,
}: {
  wineId: string;
  /** Active bottles of this wine. */
  bottles: DomainBottle[];
  onRecordValuation: () => void;
}) {
  const { repository, costs, valuations } = useCellar();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!repository) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await repository.loadValuations(wineId);
      setEntries(
        (rows ?? []).map((r: Record<string, unknown>) => ({
          id: r.id as string,
          amount: Number(r.amount ?? 0),
          currency: (r.currency as string) ?? "GBP",
          valuationBasis: (r.valuation_basis as string) ?? "manual_estimate",
          source: (r.source as string) ?? "manual",
          valuedOn: (r.valued_on as string) ?? "",
          bottleId: (r.bottle_id as string | null) ?? null,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load valuations");
    } finally {
      setLoading(false);
    }
  }, [repository, wineId]);

  useEffect(() => {
    void load();
  }, [load]);

  const holding = useMemo(
    () =>
      holdingValuation(
        bottles.map((b) => b.id),
        costs,
        valuations,
      ),
    [bottles, costs, valuations],
  );

  console.log("[valuation-panel]", {
    bottleCount: bottles.length,
    bottleIds: bottles.map((b) => b.id.slice(0, 8)),
    valuationMapSize: valuations.size,
    valuationsForTheseBottles: bottles.map((b) => ({
      bottle: b.id.slice(0, 8),
      valuation: valuations.get(b.id) ?? null,
    })),
    holding,
  });

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2 style={sectionLabel}>Valuation</h2>

      {loading ? (
        <Skeleton rows={2} />
      ) : error ? (
        <div role="alert" style={alertStyle}>
          <p style={{ marginBottom: "0.75rem" }}>{error}</p>
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <Holding holding={holding} />

          {entries.length === 0 ? (
            <div
              style={{
                padding: "1rem",
                borderRadius: 12,
                background: "var(--surface-raised)",
                border: "1px solid var(--border-subtle)",
                marginTop: "0.75rem",
              }}
            >
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.875rem",
                  lineHeight: 1.6,
                  marginBottom: "0.75rem",
                }}
              >
                No valuations recorded. Once you add one, its history is kept here so you
                can see how the value has moved.
              </p>
              <Button variant="secondary" onClick={onRecordValuation}>
                Record a valuation
              </Button>
            </div>
          ) : (
            <>
              <ul
                style={{
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  marginTop: "0.75rem",
                }}
              >
                {entries.map((e, index) => (
                  <li
                    key={e.id}
                    style={{
                      padding: "0.75rem 0.875rem",
                      borderRadius: 10,
                      background: "var(--surface-raised)",
                      border: `1px solid ${
                        index === 0 ? "rgba(217,174,85,0.3)" : "var(--border-subtle)"
                      }`,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-display)",
                          fontSize: "1.0625rem",
                          color: index === 0 ? "var(--accent-gold)" : "var(--text-primary)",
                        }}
                      >
                        {money(e.amount, e.currency)}
                        {/* Always per bottle — a wine-level valuation applies
                            this figure to each bottle, not across them. */}
                        <span
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--text-tertiary)",
                          }}
                        >
                          {" per bottle"}
                        </span>
                      </span>
                      <span
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--text-tertiary)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {e.valuedOn}
                        {index === 0 ? " · latest" : ""}
                      </span>
                    </div>

                    {/*
                      SCOPE.
                      A wine-level record says "All bottles" rather than a
                      number, because the ledger does not store how many
                      bottles it covered and the count cannot be reconstructed
                      later: `bottles.current_value_at` only points at the
                      LATEST valuation, and consumption changes the set. An
                      approximate count would read as a historical fact, so
                      none is shown.
                    */}
                    <div
                      style={{
                        fontSize: "0.75rem",
                        color: "var(--text-tertiary)",
                        marginTop: 2,
                      }}
                    >
                      {e.bottleId ? "One specific bottle" : "All bottles"}
                    </div>

                    {/* Basis and source are DIFFERENT facts and shown apart. */}
                    <div
                      style={{
                        fontSize: "0.75rem",
                        color: isFact(e.valuationBasis)
                          ? "var(--status-ready)"
                          : "var(--text-secondary)",
                        marginTop: 4,
                      }}
                    >
                      {BASIS_LABELS[e.valuationBasis] ?? e.valuationBasis}
                      {" · "}
                      <span style={{ color: "var(--text-tertiary)" }}>
                        {SOURCE_LABELS[e.source] ?? e.source}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>

              {/* Append-only: a correction is a new record, not an edit. */}
              <p
                style={{
                  fontSize: "0.6875rem",
                  color: "var(--text-tertiary)",
                  marginTop: "0.75rem",
                  lineHeight: 1.6,
                }}
              >
                Valuations are never edited or deleted. Recording a new one adds to this
                history, so earlier figures stay visible.
              </p>

              <div style={{ marginTop: "0.75rem" }}>
                <Button variant="secondary" onClick={onRecordValuation}>
                  Record a new valuation
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Holding({ holding }: { holding: ReturnType<typeof holdingValuation> }) {
  if (holding.activeBottles === 0) return null;

  return (
    <div
      style={{
        padding: "0.875rem 1rem",
        borderRadius: 12,
        background: "var(--surface-raised)",
        border: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: "0.625rem",
      }}
    >
      <MoneyLine label="Cost" totals={holding.cost} noun="costed" />
      <MoneyLine label="Value" totals={holding.value} noun="valued" />
      <GainLine gain={holding.gain} />
    </div>
  );
}

function MoneyLine({
  label,
  totals,
  noun,
}: {
  label: string;
  totals: MoneyTotals;
  noun: string;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
          {label}
        </span>
        <span style={{ fontSize: "0.9375rem", color: "var(--text-primary)" }}>
          {totals.present === 0
            ? "Not recorded"
            : totals.isMixed
              ? "Mixed currencies"
              : money(totals.single!.amount, totals.single!.currency)}
        </span>
      </div>

      {/* The completeness caption is what stops a partial figure reading as
          a complete one. */}
      {totals.present > 0 && isPartial(totals) && (
        <div style={captionStyle}>{describeCompleteness(totals, noun)}</div>
      )}

      {totals.isMixed && (
        <ul style={{ listStyle: "none", marginTop: 4 }}>
          {totals.byCurrency.map((c) => (
            <li key={c.currency} style={captionStyle}>
              {money(c.amount, c.currency)} across {c.bottles} bottle
              {c.bottles === 1 ? "" : "s"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GainLine({ gain }: { gain: HoldingGain }) {
  if (gain.comparableBottles === 0) {
    const why =
      gain.excluded.currencyMismatch > 0
        ? "cost and valuation are in different currencies"
        : gain.excluded.noValuation > gain.excluded.noCost
          ? "no valuations recorded yet"
          : "no acquisition cost recorded";
    return (
      <div>
        <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
          Unrealised gain
        </div>
        <div style={captionStyle}>Not available — {why}.</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
        Unrealised gain
      </div>

      <ul style={{ listStyle: "none", marginTop: 2 }}>
        {gain.byCurrency.map((c) => (
          <li
            key={c.currency}
            style={{
              fontSize: "0.9375rem",
              color: c.gain >= 0 ? "var(--status-ready)" : "var(--status-past)",
            }}
          >
            {c.gain >= 0 ? "+" : ""}
            {money(c.gain, c.currency)}
            {c.percent !== null && (
              <span>
                {" "}
                ({c.gain >= 0 ? "+" : ""}
                {c.percent}%)
              </span>
            )}
          </li>
        ))}
      </ul>

      {/* The gain names its own denominator. */}
      <div style={captionStyle}>
        across {gain.comparableBottles} of {gain.totalActiveBottles} bottle
        {gain.totalActiveBottles === 1 ? "" : "s"} with both cost and valuation
        {gain.isMixed ? ", not combined across currencies" : ""}
      </div>
    </div>
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
    // An unrecognised code still shows the number honestly.
    return `${currency} ${Math.round(amount)}`;
  }
}

const sectionLabel: React.CSSProperties = {
  fontSize: "0.6875rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  marginBottom: "0.625rem",
};

const captionStyle: React.CSSProperties = {
  fontSize: "0.6875rem",
  color: "var(--text-tertiary)",
  marginTop: 2,
  lineHeight: 1.6,
};

const alertStyle: React.CSSProperties = {
  padding: "1rem",
  borderRadius: 12,
  background: "var(--surface-raised)",
  border: "1px solid rgba(255,138,122,0.3)",
  color: "var(--text-secondary)",
  fontSize: "0.875rem",
};
