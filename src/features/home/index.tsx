import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import { cellarValuation } from "@/domain/valuation";
import { ValuationTotal } from "@/components/ValuationTotal";
import {
  buildCellarSummary,
  CLOSING_SOON_YEARS,
  type AttentionItem,
} from "@/domain/cellar-summary";
import { SummaryCard } from "@/components/SummaryCard";
import { Skeleton } from "@/components/Skeleton";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";

/**
 * Home — "today's actions and insight" (phase-0-audit.md §14).
 *
 * Everything shown is a FACT derived from data the user already has. There is
 * no scoring, forecasting or recommendation here; that is Phase 8.
 *
 * Wording is deliberately literal. The domain knows the YEAR a window opens
 * and closes, so "Ready to drink" is accurate where "Ready tonight" would
 * claim knowledge the model does not have.
 *
 * No network request is made for Home. It reads state `useCellar` has already
 * loaded and aggregates it with pure memoised functions.
 */
export default function Home() {
  const { state, error, wines, bottles, locations, valuations, refresh } = useCellar();
  const navigate = useNavigate();

  // Same currency-aware structure as Wine Detail and Collection.
  const cellarValue = useMemo(
    () => cellarValuation(bottles, valuations),
    [bottles, valuations],
  );

  const summary = useMemo(() => buildCellarSummary(wines, locations), [wines, locations]);

  if (state === "loading") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Header />
        <Skeleton rows={4} />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Header />
        <div
          role="alert"
          style={{
            padding: "1.25rem",
            borderRadius: 14,
            background: "var(--surface-raised)",
            border: "1px solid rgba(255,138,122,0.3)",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.25rem",
              fontStyle: "italic",
              color: "var(--status-past)",
              marginBottom: "0.5rem",
            }}
          >
            Could not load your cellar
          </h2>
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: "0.875rem",
              marginBottom: "1rem",
            }}
          >
            {error}
          </p>
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (summary.isEmpty) {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Header />
        <EmptyState
          title="Your cellar is empty"
          description="Add your first wine and this page will show what is ready to drink, what is closing, and how full your storage is."
          action={<Button onClick={() => navigate("/add")}>Add your first wine</Button>}
        />
      </div>
    );
  }

  const { totals, readiness, attention, storage } = summary;

  return (
    <div style={{ padding: "1.25rem" }}>
      <Header />

      <p
        style={{
          fontSize: "0.8125rem",
          color: "var(--text-secondary)",
          marginBottom: "1.25rem",
        }}
      >
        {totals.bottles} bottle{totals.bottles === 1 ? "" : "s"} · {totals.wines} wine
        {totals.wines === 1 ? "" : "s"}
        {/* Currency-aware and completeness-aware. Never a bare combined
            number across currencies. */}
        {cellarValue.present > 0 && (
          <>
            {" · "}
            <ValuationTotal totals={cellarValue} inline />
          </>
        )}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* 1 — READY TO DRINK. Hidden when nothing is ready. */}
        {readiness.readyBottles > 0 && (
          <SummaryCard
            title="Ready to drink"
            value={`${readiness.readyBottles} bottle${readiness.readyBottles === 1 ? "" : "s"}`}
            detail={`Across ${readiness.readyWines} wine${readiness.readyWines === 1 ? "" : "s"} whose drinking window is open.`}
            accent="var(--status-ready)"
            onClick={() =>
              navigate("/cellar", { state: { filters: { readiness: ["ready"] } } })
            }
          />
        )}

        {/* 2 — CLOSING SOON. A subset of ready, so only shown when non-zero. */}
        {readiness.closingSoonBottles > 0 && (
          <SummaryCard
            title="Closing soon"
            value={`${readiness.closingSoonBottles} bottle${readiness.closingSoonBottles === 1 ? "" : "s"}`}
            detail={`Drinking window closes within ${CLOSING_SOON_YEARS} year${CLOSING_SOON_YEARS === 1 ? "" : "s"}.`}
            accent="var(--status-approaching)"
            onClick={() =>
              navigate("/cellar", { state: { filters: { readiness: ["ready"] } } })
            }
          />
        )}

        {/* 3 — STORAGE PRESSURE. Null when no bounded storage exists. */}
        {storage && (
          <SummaryCard
            title="Storage"
            value={`${storage.percentFull}% full`}
            detail={
              `${storage.free} free slot${storage.free === 1 ? "" : "s"} across ` +
              `${storage.boundedLocations} location${storage.boundedLocations === 1 ? "" : "s"}` +
              (storage.unboundedBottles > 0
                ? `. ${storage.unboundedBottles} bottle${storage.unboundedBottles === 1 ? "" : "s"} in storage without fixed positions.`
                : ".")
            }
            accent={
              storage.percentFull >= 90 ? "var(--status-approaching)" : "var(--accent-gold)"
            }
            onClick={() => navigate("/storage")}
          >
            <div
              aria-hidden
              style={{
                height: 4,
                borderRadius: 2,
                marginTop: "0.75rem",
                background: "var(--border-subtle)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, storage.percentFull)}%`,
                  background:
                    storage.percentFull >= 90
                      ? "var(--status-approaching)"
                      : "var(--accent-gold)",
                }}
              />
            </div>

            {storage.fullLocations.length > 0 && (
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--status-approaching)",
                  marginTop: "0.5rem",
                }}
              >
                Full: {storage.fullLocations.map((l) => l.name).join(", ")}
              </p>
            )}
          </SummaryCard>
        )}

        {/* 4 — NEEDS ATTENTION. Past-window bottles plus missing information. */}
        {(readiness.pastWindowBottles > 0 || attention.length > 0) && (
          <SummaryCard
            title="Needs attention"
            accent="var(--status-past)"
            onClick={() => navigate("/cellar")}
          >
            <ul
              style={{
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                marginTop: "0.5rem",
              }}
            >
              {readiness.pastWindowBottles > 0 && (
                <li style={attentionRow}>
                  {readiness.pastWindowBottles} bottle
                  {readiness.pastWindowBottles === 1 ? "" : "s"} past their drinking window
                </li>
              )}
              {attention.map((item: AttentionItem) => (
                <li key={item.kind} style={attentionRow}>
                  {item.label}
                </li>
              ))}
            </ul>
          </SummaryCard>
        )}
      </div>
    </div>
  );
}

function Header() {
  return (
    <header style={{ marginBottom: "1.25rem" }}>
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.875rem",
          fontStyle: "italic",
        }}
      >
        Home
      </h1>
      <p
        style={{
          fontSize: "0.6875rem",
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
          marginTop: "0.25rem",
        }}
      >
        Your cellar today
      </p>
    </header>
  );
}

const attentionRow: React.CSSProperties = {
  fontSize: "0.8125rem",
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};
