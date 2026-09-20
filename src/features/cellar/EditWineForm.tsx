import { useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { GeographyPicker, type GeoSelection } from "@/features/add-wine/GeographyPicker";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";
import type { DomainWine, WineColour } from "@/domain/types";

/**
 * Correct a wine definition.
 *
 * ── THIS EDITS THE LABEL, NOT THE BOTTLES ────────────────────────────────
 * Everything here belongs to the WineDefinition. Bottles keep their ids,
 * positions, status, acquisition records, tastings and event history, and
 * simply display the corrected details afterwards. The RPC writes no
 * bottle_events, because correcting a typo is not an event in a bottle's life.
 *
 * ── WINE TYPE IS REQUIRED ────────────────────────────────────────────────
 * Production allowed typeless wines, so some existing rows have none. This
 * form ALWAYS sends a type, which means opening a legacy wine and saving it
 * is how that gap gets closed — the user chooses, nothing is guessed.
 *
 * Deselecting is impossible: tapping the selected type does not clear it.
 * Migration 016 rejects a cleared type at the mutation boundary too.
 */

const COLOURS: WineColour[] = ["Red", "White", "Rosé", "Sparkling", "Dessert", "Fortified"];

export interface EditWinePatch extends Record<string, unknown> {
  producer: string;
  name: string;
  vintage: number | null;
  colour: WineColour;
  grapes: string[];
  geo_region_id: string | null;
  country_code: string | null;
  region_text: string | null;
  drink_from: number | null;
  drink_until: number | null;
  notes: string | null;
}

/** Validation shared by the form and its tests. */
export function validateEdit(draft: {
  producer: string;
  name: string;
  colour: WineColour | null;
  drinkFrom: number | null;
  drinkUntil: number | null;
}): string | null {
  if (!draft.producer.trim()) return "A producer is needed.";
  if (!draft.name.trim()) return "A wine name is needed.";
  // Mirrors migration 016. The database remains authoritative.
  if (!draft.colour) return "Choose a wine type.";
  if (
    draft.drinkFrom !== null &&
    draft.drinkUntil !== null &&
    draft.drinkFrom > draft.drinkUntil
  ) {
    return "The drinking window cannot close before it opens.";
  }
  return null;
}

export function EditWineForm({
  wine,
  onCancel,
  onSave,
}: {
  wine: DomainWine;
  onCancel: () => void;
  onSave: (patch: EditWinePatch) => Promise<{ ok: boolean; error?: string | null }>;
}) {
  const [producer, setProducer] = useState(wine.producer);
  const [name, setName] = useState(wine.name);
  const [vintage, setVintage] = useState(wine.vintage?.toString() ?? "");
  const [colour, setColour] = useState<WineColour | null>(wine.colour);
  const [grapes, setGrapes] = useState<string[]>(wine.grapes);
  const [grapeInput, setGrapeInput] = useState("");
  const [drinkFrom, setDrinkFrom] = useState(wine.drinkFrom?.toString() ?? "");
  const [drinkUntil, setDrinkUntil] = useState(wine.drinkUntil?.toString() ?? "");
  const [notes, setNotes] = useState(wine.notes ?? "");

  // Preloaded from the canonical hierarchy the wine already points at.
  const [geo, setGeo] = useState<GeoSelection>({
    geoRegionId: wine.geography.appellation?.id ?? wine.geography.region?.id ?? null,
    countryCode: wine.geography.country?.code ?? null,
    regionText: wine.geography.unmatched,
    label:
      [
        wine.geography.appellation?.name,
        wine.geography.region?.name,
        wine.geography.country?.name,
      ]
        .filter(Boolean)
        .join(" · ") || null,
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toNumber = (v: string): number | null => {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isInteger(n) ? n : null;
  };

  const problem = useMemo(
    () =>
      validateEdit({
        producer,
        name,
        colour,
        drinkFrom: toNumber(drinkFrom),
        drinkUntil: toNumber(drinkUntil),
      }),
    [producer, name, colour, drinkFrom, drinkUntil],
  );

  const save = async () => {
    if (problem || !colour) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);

    const result = await onSave({
      producer: producer.trim(),
      name: name.trim(),
      vintage: toNumber(vintage),
      colour,
      grapes,
      geo_region_id: geo.geoRegionId,
      country_code: geo.countryCode,
      region_text: geo.regionText,
      drink_from: toNumber(drinkFrom),
      drink_until: toNumber(drinkUntil),
      notes: notes.trim() || null,
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Could not save. Your change is queued.");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
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

      <Field
        label="Producer"
        value={producer}
        onChange={(e) => setProducer(e.target.value)}
      />
      <Field label="Wine" value={name} onChange={(e) => setName(e.target.value)} />
      <Field
        label="Vintage"
        type="number"
        inputMode="numeric"
        value={vintage}
        onChange={(e) => setVintage(e.target.value)}
        hint="Leave blank for non-vintage"
      />

      <fieldset style={{ border: "none" }}>
        <legend style={legendStyle}>Type</legend>
        <div
          role="radiogroup"
          aria-label="Wine type"
          style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
        >
          {COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={colour === c}
              // Selecting only. Tapping the current type does NOT clear it:
              // every wine must have one.
              onClick={() => setColour(c)}
              style={chipStyle(colour === c)}
            >
              {c}
            </button>
          ))}
        </div>
        {colour === null && (
          <p
            style={{
              fontSize: "0.75rem",
              color: "var(--status-approaching)",
              marginTop: "0.5rem",
              lineHeight: 1.6,
            }}
          >
            This wine has no type recorded. Choose one to save your changes.
          </p>
        )}
      </fieldset>

      <fieldset style={{ border: "none" }}>
        <legend style={legendStyle}>Grapes</legend>
        <input
          aria-label="Add a grape"
          value={grapeInput}
          placeholder="Nebbiolo, then Enter"
          onChange={(e) => setGrapeInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && grapeInput.trim()) {
              e.preventDefault();
              if (!grapes.includes(grapeInput.trim())) {
                setGrapes([...grapes, grapeInput.trim()]);
              }
              setGrapeInput("");
            }
          }}
          style={inputStyle}
        />
        {grapes.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {grapes.map((g) => (
              <button
                key={g}
                type="button"
                aria-label={`Remove ${g}`}
                onClick={() => setGrapes(grapes.filter((x) => x !== g))}
                style={chipStyle(true)}
              >
                {g} ✕
              </button>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset style={{ border: "none" }}>
        <legend style={legendStyle}>Where it is from</legend>
        {/*
          The SAME canonical picker Add Wine uses. Geography is never invented
          here, and no parallel region record is created: free text is stored
          as free text, canonical nodes as ids.
        */}
        <GeographyPicker value={geo} onChange={setGeo} />
      </fieldset>

      <fieldset style={{ border: "none" }}>
        <legend style={legendStyle}>Drinking window</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field
            label="From"
            type="number"
            inputMode="numeric"
            value={drinkFrom}
            onChange={(e) => setDrinkFrom(e.target.value)}
          />
          <Field
            label="Until"
            type="number"
            inputMode="numeric"
            value={drinkUntil}
            onChange={(e) => setDrinkUntil(e.target.value)}
          />
        </div>
      </fieldset>

      <Field label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />

      {problem && (
        <p style={{ fontSize: "0.75rem", color: "var(--status-approaching)" }}>{problem}</p>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Cancel
        </Button>
        <Button fullWidth disabled={busy || problem !== null} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

const legendStyle: React.CSSProperties = {
  fontSize: "0.6875rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  marginBottom: "0.5rem",
};

const chipStyle = (on: boolean): React.CSSProperties => ({
  minHeight: TOUCH_TARGET_MIN_PX - 8,
  padding: "0.5rem 0.875rem",
  borderRadius: 999,
  fontSize: "0.8125rem",
  background: on ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
  border: `1px solid ${on ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"}`,
  color: on ? "var(--accent-gold)" : "var(--text-secondary)",
});

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
