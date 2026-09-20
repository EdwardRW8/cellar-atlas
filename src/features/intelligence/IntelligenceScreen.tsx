import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import {
  buildIntelligence,
  significantSlices,
  type Evidence,
  type MaturationWindow,
  type ConcentrationDimension,
} from "@/domain/intelligence";
import { SummaryCard } from "@/components/SummaryCard";
import { Skeleton } from "@/components/Skeleton";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";

/**
 * Intelligence.
 *
 * ── PRESENTS, NEVER CALCULATES ───────────────────────────────────────────
 * Every number here comes from `buildIntelligence()`. This component contains
 * no arithmetic beyond formatting. An architecture test asserts that.
 *
 * ── EVERY STATEMENT SHOWS ITS EVIDENCE ───────────────────────────────────
 * No opaque score. Each insight is a sentence followed by what it was derived
 * from — "Based on 18 consumed bottles over 11 months" — so the user can
 * judge it rather than trust it.
 *
 * ── SUPPRESSION IS A FEATURE ─────────────────────────────────────────────
 * When evidence is insufficient the insight is absent and the reason is
 * stated. Showing a longevity figure derived from two bottles would be worse
 * than showing nothing.
 */
export default function Intelligence() {
  const { state, error, wines, bottles, profile, refresh } = useCellar();
  const navigate = useNavigate();

  const intel = useMemo(
    () => buildIntelligence(wines, bottles, profile),
    [wines, bottles, profile],
  );

  if (state === "loading") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Header />
        <Skeleton rows={3} />
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

  if (intel.isEmpty) {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Header />
        <EmptyState
          title="Nothing to interpret yet"
          description="Once you have wines with drinking windows, this page will tell you how your cellar's maturing compares with how much you actually drink."
          action={<Button onClick={() => navigate("/add")}>Add a wine</Button>}
        />
      </div>
    );
  }

  const { capacity, longevity, legacy, concentration } = intel;
  const fiveYear = longevity.windows.find((w) => w.years === 5)!;

  return (
    <div style={{ padding: "1.25rem" }}>
      <Header />

      {/* ① CONSUMPTION — everything else depends on this */}
      {capacity.bottlesPerYear === null ? (
        <SummaryCard title="Drinking rate" accent="var(--text-tertiary)">
          <p style={bodyStyle}>
            Not enough information yet. Record a few consumed bottles, or set an estimate in
            your profile, and the rest of this page becomes available.
          </p>
          <Button variant="secondary" onClick={() => navigate("/profile")}>
            Set an estimate
          </Button>
        </SummaryCard>
      ) : (
        <SummaryCard
          title="Drinking rate"
          value={`${capacity.bottlesPerYear} bottles a year`}
          detail={`About ${capacity.bottlesPerMonth} a month.`}
          accent="var(--accent-gold)"
        >
          <EvidenceNote evidence={capacity.evidence} />
        </SummaryCard>
      )}

      {/* ② CELLAR LONGEVITY — maturation against capacity */}
      {longevity.hasProjection && (
        <div style={{ marginTop: 10 }}>
          <SummaryCard title="Cellar longevity" accent="var(--status-ready)">
            <p style={bodyStyle}>
              <strong style={{ color: "var(--text-primary)" }}>
                {fiveYear.drinkableBottles} bottles
              </strong>{" "}
              are expected to be drinkable during the next five years. At your current rate
              you would consume approximately{" "}
              <strong style={{ color: "var(--text-primary)" }}>
                {fiveYear.expectedConsumption!.low}–{fiveYear.expectedConsumption!.high}
              </strong>
              .
            </p>

            {fiveYear.surplusClosing !== null && fiveYear.surplusClosing > 0 && (
              <p style={{ ...bodyStyle, color: "var(--status-approaching)" }}>
                {fiveYear.surplusClosing} bottles may outpace your drinking capacity before
                their windows close.
              </p>
            )}

            <HorizonTable windows={longevity.windows} />

            {longevity.yearsOfDrinkingAtCurrentRate && (
              <p style={supportingStyle}>
                Supporting figure: at this rate your current {longevity.activeBottles}{" "}
                bottles represent roughly {longevity.yearsOfDrinkingAtCurrentRate.low}–
                {longevity.yearsOfDrinkingAtCurrentRate.high} years of drinking, ignoring
                when each becomes ready.
              </p>
            )}

            <EvidenceNote evidence={longevity.evidence} />
          </SummaryCard>
        </div>
      )}

      {/* ③ LEGACY OUTLOOK — deliberately not called "risk" */}
      <div style={{ marginTop: 10 }}>
        {legacy.hasHorizon ? (
          <SummaryCard title="Legacy outlook" accent="var(--accent-gold)">
            <p style={bodyStyle}>
              Over your {legacy.horizonYears}-year collecting horizon,{" "}
              <strong style={{ color: "var(--text-primary)" }}>
                {legacy.drinkableWithinHorizon} bottles
              </strong>{" "}
              become drinkable.
              {legacy.expectedConsumptionOverHorizon && (
                <>
                  {" "}
                  You would expect to drink {legacy.expectedConsumptionOverHorizon.low}–
                  {legacy.expectedConsumptionOverHorizon.high} in that time.
                </>
              )}
            </p>

            {legacy.beyondHorizonBottles > 0 && (
              <p style={bodyStyle}>
                {legacy.beyondHorizonBottles} bottles will still be drinkable after your
                horizon ends. That may be deliberate — long-lived wine kept on purpose is
                not a problem.
              </p>
            )}

            {legacy.consumptionConflictBottles > 0 && (
              <p style={{ ...bodyStyle, color: "var(--status-approaching)" }}>
                {legacy.consumptionConflictBottles} bottles have windows closing inside your
                horizon but exceed what you would drink in that time. These are the ones
                worth attention.
              </p>
            )}

            <EvidenceNote evidence={legacy.evidence} />
          </SummaryCard>
        ) : (
          <SummaryCard title="Legacy outlook" accent="var(--text-tertiary)">
            <p style={bodyStyle}>
              Set a collecting horizon in your profile and this will show how much of your
              cellar you are unlikely to drink within it.
            </p>
            <Button variant="secondary" onClick={() => navigate("/profile")}>
              Set a horizon
            </Button>
          </SummaryCard>
        )}
      </div>

      {/* ④ COLLECTION BALANCE — facts, no verdict */}
      <div style={{ marginTop: 10 }}>
        <SummaryCard title="Collection balance" accent="var(--accent-gold)">
          <p style={supportingStyle}>
            Shares of your cellar. These are descriptions, not judgements — a specialist
            collection is meant to look concentrated.
          </p>
          {concentration
            .filter((d) => d.slices.length > 0)
            .map((d) => (
              <Dimension key={d.dimension} dimension={d} />
            ))}
        </SummaryCard>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header style={{ marginBottom: "1rem" }}>
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.875rem",
          fontStyle: "italic",
        }}
      >
        Intelligence
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
        What your cellar is doing
      </p>
    </header>
  );
}

/**
 * The evidence behind a statement, in plain words.
 *
 * This is what replaces a confidence score. A sample size is a fact; "82%
 * confident" is a number with no defensible derivation.
 */
function EvidenceNote({ evidence }: { evidence: Evidence }) {
  const parts: string[] = [];

  if (evidence.source === "observed" || evidence.source === "mixed") {
    const months = evidence.historyDays
      ? Math.max(1, Math.round(evidence.historyDays / 30))
      : null;
    parts.push(
      `Based on ${evidence.sampleSize} consumed bottle${
        evidence.sampleSize === 1 ? "" : "s"
      }${months ? ` over ${months} month${months === 1 ? "" : "s"}` : ""}`,
    );
  } else if (evidence.source === "profile") {
    parts.push("Based on your own estimate rather than recorded history");
    if (evidence.sampleSize !== undefined && evidence.sampleSize > 0) {
      parts.push(
        `${evidence.sampleSize} consumed bottle${
          evidence.sampleSize === 1 ? "" : "s"
        } recorded so far — not yet enough to measure a rate`,
      );
    }
  }

  if (evidence.missingWindows) {
    parts.push(
      `${evidence.missingWindows} bottle${
        evidence.missingWindows === 1 ? "" : "s"
      } excluded because they have no drinking window`,
    );
  }

  if (parts.length === 0) return null;

  return (
    <p
      style={{
        fontSize: "0.6875rem",
        color: "var(--text-tertiary)",
        marginTop: "0.75rem",
        lineHeight: 1.6,
        borderTop: "1px solid var(--border-subtle)",
        paddingTop: "0.625rem",
      }}
    >
      {parts.join(". ")}.
    </p>
  );
}

function HorizonTable({ windows }: { windows: MaturationWindow[] }) {
  return (
    <div style={{ marginTop: "0.875rem", display: "flex", gap: 6 }}>
      {windows.map((w) => (
        <div
          key={w.years}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "0.625rem 0.5rem",
            borderRadius: 10,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid var(--border-subtle)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: "0.625rem",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
            }}
          >
            {w.years} year{w.years === 1 ? "" : "s"}
          </div>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.125rem",
              color: "var(--text-primary)",
              marginTop: 2,
            }}
          >
            {w.drinkableBottles}
          </div>
          <div style={{ fontSize: "0.625rem", color: "var(--text-tertiary)" }}>
            drinkable
          </div>
        </div>
      ))}
    </div>
  );
}

function Dimension({ dimension }: { dimension: ConcentrationDimension }) {
  const slices = significantSlices(dimension);

  return (
    <section style={{ marginTop: "1rem" }}>
      <h3
        style={{
          fontSize: "0.6875rem",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
          marginBottom: "0.5rem",
        }}
      >
        {dimension.label}
      </h3>

      <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
        {slices.map((s) => (
          <li key={s.key}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                fontSize: "0.8125rem",
              }}
            >
              <span style={{ color: "var(--text-secondary)" }}>{s.label}</span>
              <span style={{ color: "var(--accent-gold)" }}>{s.percentage}%</span>
            </div>
            <div
              aria-hidden
              style={{
                height: 3,
                borderRadius: 2,
                marginTop: 4,
                background: "var(--border-subtle)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, s.percentage)}%`,
                  background: "var(--accent-gold)",
                }}
              />
            </div>
          </li>
        ))}
      </ul>

      {dimension.unclassifiedBottles > 0 && (
        <p
          style={{
            fontSize: "0.625rem",
            color: "var(--text-tertiary)",
            marginTop: "0.5rem",
          }}
        >
          {dimension.unclassifiedBottles} bottle
          {dimension.unclassifiedBottles === 1 ? "" : "s"} not counted — no{" "}
          {dimension.label.toLowerCase()} recorded.
        </p>
      )}
    </section>
  );
}

const bodyStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--text-secondary)",
  lineHeight: 1.6,
  marginTop: "0.5rem",
};

const supportingStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--text-tertiary)",
  lineHeight: 1.6,
  marginTop: "0.5rem",
};
