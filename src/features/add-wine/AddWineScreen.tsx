import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import {
  emptyDraft,
  setField,
  setQuantity,
  setLocation,
  setPosition,
  validateIdentity,
  validatePlacement,
  toCommitPayload,
  type WineDraft,
  type DraftIdentity,
} from "@/domain/wine-draft";
import {
  findDuplicates,
  shouldBlock,
  type DuplicateMatch,
} from "@/domain/duplicate-detection";
import { assessWindow } from "@/domain/drinking-window";
import type { WineColour } from "@/domain/types";
import { StorageLocationPicker, PositionPicker } from "@/features/storage/StoragePickers";
import { GeographyPicker, type GeoSelection } from "./GeographyPicker";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

const STEPS = ["Wine", "Details", "Bottles", "Review"] as const;

const COLOURS: WineColour[] = ["Red", "White", "Rosé", "Sparkling", "Dessert", "Fortified"];
const SIZES = ["375ml", "750ml", "1500ml", "3000ml", "6000ml"];

export default function AddWineScreen() {
  const navigate = useNavigate();
  const { wines, locations, bottles, run, state } = useCellar();

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<WineDraft>(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const set = <K extends keyof DraftIdentity>(k: K, v: DraftIdentity[K]) =>
    setDraft((d) => setField(d, k, v));

  const [geoLabel, setGeoLabel] = useState<string | null>(null);

  /**
   * A canonical selection sets geoRegionId AND countryCode and clears
   * regionText. Free text does the reverse. Each field is written through
   * setField, so provenance is recorded per field as usual.
   */
  const applyGeography = (sel: GeoSelection) => {
    setDraft((d) => {
      let next = setField(d, "geoRegionId", sel.geoRegionId);
      next = setField(next, "countryCode", sel.countryCode);
      next = setField(next, "regionText", sel.regionText);
      return next;
    });
    setGeoLabel(sel.label);
  };

  const duplicates = useMemo(
    () => findDuplicates(draft.identity, wines),
    [draft.identity.producer, draft.identity.name, draft.identity.vintage, wines],
  );

  const location =
    locations.find((l) => l.id === draft.placement.storageLocationId) ?? null;

  /** Slots already taken in the chosen location. */
  const occupiedKeys = useMemo(() => {
    if (!location) return new Set<string>();
    return new Set(
      bottles
        .filter((b) => b.isActive && b.storageLocationId === location.id && b.positionKey)
        .map((b) => b.positionKey!),
    );
  }, [location, bottles]);

  const identityCheck = validateIdentity(draft);
  const placementCheck = validatePlacement(draft, location?.layoutType ?? null);

  const canAdvance =
    // Each step gates ONLY on fields that step actually presents.
    //
    // Wine type is mandatory, but its control lives on step 1 (Details), not
    // step 0 (Wine). Requiring it here created a deadlock: the user could not
    // leave step 0 without a type, and could not reach the type without
    // leaving step 0. The requirement now sits in validateIdentity, which
    // gates step 1 — the step that presents the control.
    step === 0
      ? Boolean(draft.identity.producer?.trim() && draft.identity.name?.trim())
      : step === 1
        ? identityCheck.valid
        : step === 2
          ? placementCheck.valid
          : true;

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);

    const outcome = await run(
      `Add ${draft.quantity} bottle${draft.quantity === 1 ? "" : "s"} of ${draft.identity.name}`,
      (m) => m.commitDraft(toCommitPayload(draft)),
    );

    setSubmitting(false);
    if (outcome.ok) navigate("/cellar");
    else setSubmitError(outcome.error ?? "Could not save. Your change is queued.");
  };

  if (state === "loading") {
    return <p style={{ padding: "1.25rem", color: "var(--text-tertiary)" }}>Loading…</p>;
  }

  return (
    <div style={{ padding: "1rem 1rem 2rem", maxWidth: 560, margin: "0 auto" }}>
      <header style={{ marginBottom: "1.25rem" }}>
        <div
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
        >
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.5rem",
              fontStyle: "italic",
            }}
          >
            Add wine
          </h1>
          <button
            onClick={() => navigate(-1)}
            style={{ minWidth: 44, minHeight: 44, color: "var(--text-tertiary)" }}
            aria-label="Cancel"
          >
            ✕
          </button>
        </div>
        <Stepper current={step} onGoTo={(i) => i < step && setStep(i)} />
      </header>

      {step === 0 && (
        <StepIdentity
          draft={draft}
          set={set}
          duplicates={duplicates}
          onUseExisting={(m) => {
            setDraft((d) => ({ ...d, existingWineId: m.wineId }));
            setStep(2);
          }}
        />
      )}

      {step === 1 && (
        <StepDetails
          draft={draft}
          set={set}
          errors={identityCheck.errors}
          geoLabel={geoLabel}
          onGeography={applyGeography}
        />
      )}

      {step === 2 && (
        <StepBottles
          draft={draft}
          setDraft={setDraft}
          locations={locations}
          location={location}
          occupiedKeys={occupiedKeys}
          errors={placementCheck.errors}
        />
      )}

      {step === 3 && (
        <StepReview
          draft={draft}
          location={location}
          error={submitError}
          geoLabel={geoLabel}
        />
      )}

      <nav style={{ display: "flex", gap: 8, marginTop: "1.75rem" }}>
        {step > 0 && (
          <Button variant="ghost" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        {step < 3 ? (
          <Button
            fullWidth
            disabled={!canAdvance || (step === 0 && shouldBlock(duplicates))}
            onClick={() => setStep(step + 1)}
          >
            Continue
          </Button>
        ) : (
          <Button fullWidth disabled={submitting} onClick={() => void submit()}>
            {submitting
              ? "Saving…"
              : `Add ${draft.quantity} bottle${draft.quantity === 1 ? "" : "s"}`}
          </Button>
        )}
      </nav>
    </div>
  );
}

function Stepper({ current, onGoTo }: { current: number; onGoTo: (i: number) => void }) {
  return (
    <ol style={{ display: "flex", gap: 6, listStyle: "none", marginTop: "0.75rem" }}>
      {STEPS.map((label, i) => (
        <li key={label} style={{ flex: 1 }}>
          <button
            onClick={() => onGoTo(i)}
            disabled={i >= current}
            aria-current={i === current ? "step" : undefined}
            style={{
              width: "100%",
              textAlign: "left",
              cursor: i < current ? "pointer" : "default",
            }}
          >
            <span
              style={{
                display: "block",
                height: 3,
                borderRadius: 2,
                background: i <= current ? "var(--accent-gold)" : "var(--border-subtle)",
              }}
            />
            <span
              style={{
                display: "block",
                marginTop: 6,
                fontSize: "0.6875rem",
                letterSpacing: "0.06em",
                color: i === current ? "var(--accent-gold)" : "var(--text-tertiary)",
              }}
            >
              {label}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

// ── STEP 1 ────────────────────────────────────────────────────────────────

function StepIdentity({
  draft,
  set,
  duplicates,
  onUseExisting,
}: {
  draft: WineDraft;
  set: <K extends keyof DraftIdentity>(k: K, v: DraftIdentity[K]) => void;
  duplicates: DuplicateMatch[];
  onUseExisting: (m: DuplicateMatch) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Field
        label="Producer"
        value={draft.identity.producer ?? ""}
        onChange={(e) => set("producer", e.target.value)}
        placeholder="Château Margaux"
        autoFocus
      />
      <Field
        label="Wine name"
        value={draft.identity.name ?? ""}
        onChange={(e) => set("name", e.target.value)}
        placeholder="Château Margaux"
      />
      <Field
        label="Vintage"
        type="number"
        inputMode="numeric"
        value={draft.identity.vintage ?? ""}
        onChange={(e) =>
          set("vintage", e.target.value === "" ? null : Number(e.target.value))
        }
        placeholder="2018"
        hint="Leave blank for non-vintage"
      />

      {duplicates.length > 0 && (
        <div
          style={{
            padding: "1rem",
            borderRadius: 12,
            background: "rgba(245,181,68,0.08)",
            border: "1px solid rgba(245,181,68,0.3)",
          }}
        >
          <p
            style={{
              color: "var(--status-approaching)",
              fontSize: "0.875rem",
              marginBottom: "0.75rem",
            }}
          >
            {shouldBlock(duplicates)
              ? "You already own this wine."
              : "This looks similar to a wine you own."}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {duplicates.map((m) => (
              <button
                key={m.wineId}
                onClick={() => onUseExisting(m)}
                style={{
                  textAlign: "left",
                  minHeight: TOUCH_TARGET_MIN_PX,
                  padding: "0.625rem 0.875rem",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-secondary)",
                  fontSize: "0.8125rem",
                }}
              >
                <strong style={{ color: "var(--text-primary)" }}>
                  {m.producer} — {m.name}
                  {m.vintage ? ` ${m.vintage}` : ""}
                </strong>
                <br />
                {m.activeBottles} bottle{m.activeBottles === 1 ? "" : "s"} · {m.reason}
                <br />
                <span style={{ color: "var(--accent-gold)" }}>
                  Add bottles to this wine →
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── STEP 2 ────────────────────────────────────────────────────────────────

function StepDetails({
  draft,
  set,
  errors,
  geoLabel,
  onGeography,
}: {
  draft: WineDraft;
  set: <K extends keyof DraftIdentity>(k: K, v: DraftIdentity[K]) => void;
  errors: Record<string, string | undefined>;
  geoLabel: string | null;
  onGeography: (s: GeoSelection) => void;
}) {
  const [grapeInput, setGrapeInput] = useState("");
  const window = assessWindow({
    from: draft.identity.drinkFrom,
    until: draft.identity.drinkUntil,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <fieldset style={{ border: "none" }}>
        <legend style={labelStyle}>Type</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={draft.identity.colour === c}
              aria-pressed={draft.identity.colour === c}
              // Selecting only: tapping the current type does not clear it.
              onClick={() => set("colour", c)}
              style={chipStyle(draft.identity.colour === c)}
            >
              {c}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <label style={labelStyle} htmlFor="grape-input">
          Grapes
        </label>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input
            id="grape-input"
            value={grapeInput}
            onChange={(e) => setGrapeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && grapeInput.trim()) {
                e.preventDefault();
                set("grapes", [...draft.identity.grapes, grapeInput.trim()]);
                setGrapeInput("");
              }
            }}
            placeholder="Cabernet Sauvignon, then Enter"
            style={inputStyle}
          />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {draft.identity.grapes.map((g) => (
            <button
              key={g}
              type="button"
              style={chipStyle(true)}
              onClick={() =>
                set(
                  "grapes",
                  draft.identity.grapes.filter((x) => x !== g),
                )
              }
            >
              {g} ✕
            </button>
          ))}
        </div>
      </div>

      <div>
        <span style={labelStyle}>Region or appellation</span>
        <GeographyPicker
          value={{
            geoRegionId: draft.identity.geoRegionId,
            countryCode: draft.identity.countryCode,
            regionText: draft.identity.regionText,
            label: geoLabel,
          }}
          onChange={onGeography}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field
          label="Drink from"
          type="number"
          inputMode="numeric"
          value={draft.identity.drinkFrom ?? ""}
          onChange={(e) =>
            set("drinkFrom", e.target.value === "" ? null : Number(e.target.value))
          }
          placeholder="2024"
        />
        <Field
          label="Drink until"
          type="number"
          inputMode="numeric"
          value={draft.identity.drinkUntil ?? ""}
          onChange={(e) =>
            set("drinkUntil", e.target.value === "" ? null : Number(e.target.value))
          }
          placeholder="2040"
          error={errors.drinkUntil}
        />
      </div>

      {(draft.identity.drinkFrom || draft.identity.drinkUntil) && (
        <p style={{ fontSize: "0.8125rem", color: "var(--text-tertiary)" }}>
          Currently: {window.label}
        </p>
      )}
    </div>
  );
}

// ── STEP 3 ────────────────────────────────────────────────────────────────

function StepBottles({
  draft,
  setDraft,
  locations,
  location,
  occupiedKeys,
  errors,
}: {
  draft: WineDraft;
  setDraft: React.Dispatch<React.SetStateAction<WineDraft>>;
  locations: ReturnType<typeof useCellar>["locations"];
  location: ReturnType<typeof useCellar>["locations"][number] | null;
  occupiedKeys: Set<string>;
  errors: Record<string, string | undefined>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div>
        <label style={labelStyle}>How many bottles?</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <QtyButton
            onClick={() => setDraft((d) => setQuantity(d, d.quantity - 1))}
            label="One fewer"
          >
            −
          </QtyButton>
          <span
            style={{
              flex: 1,
              textAlign: "center",
              fontFamily: "var(--font-display)",
              fontSize: "1.75rem",
              color: "var(--text-primary)",
            }}
            aria-live="polite"
          >
            {draft.quantity}
          </span>
          <QtyButton
            onClick={() => setDraft((d) => setQuantity(d, d.quantity + 1))}
            label="One more"
          >
            +
          </QtyButton>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {[1, 3, 6, 12].map((n) => (
            <button
              key={n}
              type="button"
              style={chipStyle(draft.quantity === n)}
              onClick={() => setDraft((d) => setQuantity(d, n))}
            >
              {n === 12 ? "Case of 12" : n === 6 ? "Half case" : `${n}`}
            </button>
          ))}
        </div>
      </div>

      <fieldset style={{ border: "none" }}>
        <legend style={labelStyle}>Bottle size</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {SIZES.map((s) => (
            <button
              key={s}
              type="button"
              style={chipStyle(draft.bottleSize === s)}
              onClick={() => setDraft((d) => ({ ...d, bottleSize: s }))}
            >
              {s}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <label style={labelStyle}>Where are they going?</label>
        <StorageLocationPicker
          locations={locations}
          value={draft.placement.storageLocationId}
          onChange={(id) => setDraft((d) => setLocation(d, id))}
        />
      </div>

      {location && (
        <div>
          <label style={labelStyle}>Positions</label>
          <PositionPicker
            location={location}
            occupiedKeys={occupiedKeys}
            positions={draft.placement.positions}
            onChange={(i, p) => setDraft((d) => setPosition(d, i, p))}
          />
          {Object.values(errors).filter(Boolean).length > 0 && (
            <p
              role="alert"
              style={{ color: "var(--status-past)", fontSize: "0.75rem", marginTop: 6 }}
            >
              {Object.values(errors).filter(Boolean)[0]}
            </p>
          )}
        </div>
      )}

      <details>
        <summary
          style={{
            ...labelStyle,
            cursor: "pointer",
            minHeight: 44,
            display: "flex",
            alignItems: "center",
          }}
        >
          Purchase details (optional)
        </summary>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            paddingTop: "0.75rem",
          }}
        >
          <Field
            label="Purchased on"
            type="date"
            value={draft.acquisition?.purchasedOn ?? ""}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                acquisition: {
                  ...defaultAcquisition(d),
                  purchasedOn: e.target.value || null,
                },
              }))
            }
          />
          <Field
            label="Merchant"
            value={draft.acquisition?.source ?? ""}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                acquisition: { ...defaultAcquisition(d), source: e.target.value || null },
              }))
            }
          />
          <Field
            label="Price per bottle"
            type="number"
            inputMode="decimal"
            value={draft.acquisition?.unitPrice ?? ""}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                acquisition: {
                  ...defaultAcquisition(d),
                  unitPrice: e.target.value === "" ? null : Number(e.target.value),
                },
              }))
            }
          />
        </div>
      </details>
    </div>
  );
}

function defaultAcquisition(d: WineDraft) {
  return (
    d.acquisition ?? {
      purchasedOn: null,
      source: null,
      reference: null,
      unitPrice: null,
      currency: "GBP",
      format: (d.quantity === 12 ? "case_12" : d.quantity === 6 ? "case_6" : "loose") as
        "case_12" | "case_6" | "case_3" | "loose",
      dutyPaid: true,
    }
  );
}

function QtyButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        minWidth: TOUCH_TARGET_MIN_PX + 8,
        minHeight: TOUCH_TARGET_MIN_PX + 8,
        borderRadius: 12,
        fontSize: "1.5rem",
        background: "rgba(255,255,255,0.05)",
        border: "1px solid var(--border-strong)",
        color: "var(--text-primary)",
      }}
    >
      {children}
    </button>
  );
}

// ── STEP 4 ────────────────────────────────────────────────────────────────

function StepReview({
  draft,
  location,
  error,
  geoLabel,
}: {
  draft: WineDraft;
  location: ReturnType<typeof useCellar>["locations"][number] | null;
  error: string | null;
  geoLabel: string | null;
}) {
  const rows: [string, string][] = [
    ["Producer", draft.identity.producer ?? "—"],
    ["Wine", draft.identity.name ?? "—"],
    ["Vintage", draft.identity.vintage?.toString() ?? "Non-vintage"],
    ["Type", draft.identity.colour ?? "—"],
    ["Grapes", draft.identity.grapes.join(", ") || "—"],
    ["Region", geoLabel ?? draft.identity.regionText ?? "—"],
    [
      "Drinking window",
      draft.identity.drinkFrom || draft.identity.drinkUntil
        ? `${draft.identity.drinkFrom ?? "?"} – ${draft.identity.drinkUntil ?? "?"}`
        : "Unknown",
    ],
    ["Bottles", `${draft.quantity} × ${draft.bottleSize}`],
    ["Location", location?.name ?? "None yet"],
  ];

  if (draft.acquisition?.unitPrice) {
    rows.push(["Price per bottle", `£${draft.acquisition.unitPrice}`]);
    rows.push(["Total", `£${draft.acquisition.unitPrice * draft.quantity}`]);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {draft.existingWineId && (
        <p
          style={{
            padding: "0.75rem 1rem",
            borderRadius: 10,
            background: "rgba(110,231,160,0.08)",
            border: "1px solid rgba(110,231,160,0.25)",
            color: "var(--status-ready)",
            fontSize: "0.8125rem",
          }}
        >
          Adding bottles to a wine you already own.
        </p>
      )}

      <dl
        style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.625rem 1rem" }}
      >
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>{k}</dt>
            <dd
              style={{
                fontSize: "0.875rem",
                color: "var(--text-primary)",
                textAlign: "right",
              }}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>

      {location?.isPositioned && (
        <div>
          <p style={labelStyle}>Positions</p>
          <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
            {draft.placement.positions
              .map((p) =>
                p
                  ? Object.entries(p)
                      .map(([k, v]) => `${k}${v}`)
                      .join("")
                  : "?",
              )
              .join(", ")}
          </p>
        </div>
      )}

      {error && (
        <p
          role="alert"
          style={{
            padding: "0.75rem 1rem",
            borderRadius: 10,
            background: "rgba(255,138,122,0.08)",
            border: "1px solid rgba(255,138,122,0.25)",
            color: "var(--status-past)",
            fontSize: "0.8125rem",
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

// ── shared styles ─────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.6875rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  marginBottom: "0.5rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: TOUCH_TARGET_MIN_PX,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid var(--border-strong)",
  borderRadius: 10,
  padding: "0.6875rem 0.875rem",
  color: "var(--text-primary)",
  fontSize: "1rem",
  outline: "none",
};

function chipStyle(selected: boolean): React.CSSProperties {
  return {
    minHeight: TOUCH_TARGET_MIN_PX - 8,
    padding: "0.5rem 0.875rem",
    borderRadius: 999,
    fontSize: "0.8125rem",
    background: selected ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${selected ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"}`,
    color: selected ? "var(--accent-gold)" : "var(--text-secondary)",
  };
}
