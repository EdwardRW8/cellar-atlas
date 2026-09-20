import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import { emptyProfile, type CellarProfile } from "@/domain/intelligence/types";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Skeleton } from "@/components/Skeleton";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * Cellar profile.
 *
 * ── WHAT "PROFILE" MEANS HERE ────────────────────────────────────────────
 * The cellar's BEHAVIOURAL profile, not account settings. `cellar_profiles`
 * is keyed on cellar_id and its migration says it exists "so Phase 8
 * intelligence has assumptions to reason from". Account concerns already live
 * on More.
 *
 * ── EVERY FIELD OPTIONAL ─────────────────────────────────────────────────
 * Migration 011: "intelligence must degrade gracefully rather than demanding
 * a questionnaire before the app is usable." Saving an entirely blank profile
 * is valid and must not break anything.
 *
 * ── TWO FIELDS DELIBERATELY ABSENT ───────────────────────────────────────
 * `favourite_regions` and `currency` exist on the table but
 * `upsert_cellar_profile` does not write them, and Phase 8 adds no RPC.
 * Offering inputs that silently fail to save would be worse than omitting
 * them.
 */
export default function ProfileScreen() {
  const { state, profile, run, refresh } = useCellar();
  const navigate = useNavigate();

  const [draft, setDraft] = useState<CellarProfile>(profile ?? emptyProfile());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (profile) setDraft(profile);
  }, [profile]);

  if (state === "loading") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Skeleton rows={4} />
      </div>
    );
  }

  const num = (v: string): number | null => {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const save = async () => {
    setBusy(true);
    setFailed(null);
    setSaved(false);

    const outcome = await run("Save cellar profile", (m) =>
      m.upsertProfile({
        bottles_per_month: draft.bottlesPerMonth,
        bottles_purchased_per_year: draft.bottlesPurchasedPerYear,
        typical_purchase_quantity: draft.typicalPurchaseQuantity,
        prefers_ageing: draft.prefersAgeing,
        collecting_horizon_years: draft.collectingHorizonYears,
        favourite_grapes: draft.favouriteGrapes,
        dislikes: draft.dislikes,
        typical_bottle_budget: draft.typicalBottleBudget,
        values_investment: draft.valuesInvestment,
        onboarding_completed_at: draft.onboardingCompletedAt ?? new Date().toISOString(),
      }),
    );

    setBusy(false);
    if (outcome.ok) {
      setSaved(true);
      await refresh();
    } else {
      setFailed(outcome.error ?? "Could not save. Your change is queued.");
    }
  };

  return (
    <div style={{ padding: "1.25rem" }}>
      <button
        onClick={() => navigate("/more")}
        style={{
          minHeight: TOUCH_TARGET_MIN_PX,
          color: "var(--text-tertiary)",
          fontSize: "0.8125rem",
          marginBottom: "0.5rem",
        }}
      >
        ← More
      </button>

      <header style={{ marginBottom: "1.25rem" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.5rem",
            fontStyle: "italic",
          }}
        >
          Cellar profile
        </h1>
        <p
          style={{
            fontSize: "0.8125rem",
            color: "var(--text-secondary)",
            marginTop: "0.375rem",
            lineHeight: 1.6,
          }}
        >
          How you drink and buy. Everything here is optional — leave anything blank and
          Intelligence simply says less rather than guessing.
        </p>
      </header>

      {failed && (
        <p role="alert" style={alertStyle("var(--status-past)")}>
          {failed}
        </p>
      )}
      {saved && !failed && (
        <p role="status" style={alertStyle("var(--status-ready)")}>
          Profile saved.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <Section label="Drinking">
          <Field
            label="Bottles a month"
            type="number"
            inputMode="decimal"
            value={draft.bottlesPerMonth ?? ""}
            onChange={(e) => setDraft({ ...draft, bottlesPerMonth: num(e.target.value) })}
            hint="Used only when there is not enough recorded history to measure"
          />
          <Field
            label="Collecting horizon (years)"
            type="number"
            inputMode="numeric"
            value={draft.collectingHorizonYears ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, collectingHorizonYears: num(e.target.value) })
            }
            hint="How far ahead you are buying for. Enables Legacy outlook."
          />
        </Section>

        <Section label="Buying">
          <Field
            label="Bottles bought a year"
            type="number"
            inputMode="numeric"
            value={draft.bottlesPurchasedPerYear ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, bottlesPurchasedPerYear: num(e.target.value) })
            }
          />
          <Field
            label="Typical purchase size"
            type="number"
            inputMode="numeric"
            value={draft.typicalPurchaseQuantity ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, typicalPurchaseQuantity: num(e.target.value) })
            }
            hint="Bottles at a time — 1, 6, 12"
          />
          <Field
            label="Typical bottle budget (£)"
            type="number"
            inputMode="decimal"
            value={draft.typicalBottleBudget ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, typicalBottleBudget: num(e.target.value) })
            }
          />
        </Section>

        <Section label="Preferences">
          <Toggle
            label="I prefer wines that age"
            value={draft.prefersAgeing}
            onChange={(v) => setDraft({ ...draft, prefersAgeing: v })}
          />
          <Toggle
            label="I care about investment value"
            value={draft.valuesInvestment}
            onChange={(v) => setDraft({ ...draft, valuesInvestment: v })}
          />
          <TagField
            label="Favourite grapes"
            values={draft.favouriteGrapes}
            onChange={(favouriteGrapes) => setDraft({ ...draft, favouriteGrapes })}
            placeholder="Nebbiolo, then Enter"
          />
          <TagField
            label="Dislikes"
            values={draft.dislikes}
            onChange={(dislikes) => setDraft({ ...draft, dislikes })}
            placeholder="Oaked Chardonnay, then Enter"
          />
        </Section>

        <Button fullWidth disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: "none" }}>
      <legend
        style={{
          fontSize: "0.6875rem",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
          marginBottom: "0.625rem",
        }}
      >
        {label}
      </legend>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        {children}
      </div>
    </fieldset>
  );
}

/** Three-state: yes, no, or unanswered. Unanswered is the default. */
function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const options: [boolean | null, string][] = [
    [true, "Yes"],
    [false, "No"],
    [null, "Not sure"],
  ];

  return (
    <div>
      <span
        style={{
          display: "block",
          fontSize: "0.8125rem",
          color: "var(--text-secondary)",
          marginBottom: "0.5rem",
        }}
      >
        {label}
      </span>
      <div role="radiogroup" aria-label={label} style={{ display: "flex", gap: 6 }}>
        {options.map(([v, l]) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(v)}
            style={{
              minHeight: TOUCH_TARGET_MIN_PX - 8,
              padding: "0.5rem 0.875rem",
              borderRadius: 999,
              fontSize: "0.8125rem",
              background: value === v ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${
                value === v ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"
              }`,
              color: value === v ? "var(--accent-gold)" : "var(--text-secondary)",
            }}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function TagField({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState("");
  const id = `tag-${label.replace(/\s+/g, "-").toLowerCase()}`;

  return (
    <div>
      <label
        htmlFor={id}
        style={{
          display: "block",
          fontSize: "0.8125rem",
          color: "var(--text-secondary)",
          marginBottom: "0.5rem",
        }}
      >
        {label}
      </label>
      <input
        id={id}
        value={input}
        placeholder={placeholder}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && input.trim()) {
            e.preventDefault();
            if (!values.includes(input.trim())) onChange([...values, input.trim()]);
            setInput("");
          }
        }}
        style={{
          width: "100%",
          minHeight: TOUCH_TARGET_MIN_PX,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid var(--border-strong)",
          borderRadius: 10,
          padding: "0.6875rem 0.875rem",
          color: "var(--text-primary)",
          fontSize: "1rem",
          outline: "none",
        }}
      />
      {values.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {values.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={`Remove ${v}`}
              style={{
                minHeight: TOUCH_TARGET_MIN_PX - 8,
                padding: "0.5rem 0.875rem",
                borderRadius: 999,
                fontSize: "0.8125rem",
                background: "rgba(217,174,85,0.14)",
                border: "1px solid rgba(217,174,85,0.4)",
                color: "var(--accent-gold)",
              }}
            >
              {v} ✕
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const alertStyle = (colour: string): React.CSSProperties => ({
  padding: "0.75rem 1rem",
  borderRadius: 10,
  marginBottom: "1rem",
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${colour}`,
  color: colour,
  fontSize: "0.8125rem",
});
