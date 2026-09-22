import { isBottleSize } from "./bottle-size";
/**
 * WineDraft — the single ingestion contract.
 *
 * Every way a wine can enter the system produces this shape:
 *
 *     manual entry  ─┐
 *     photo scan    ─┤
 *     barcode       ─┼──► WineDraft ──► review ──► commit RPC
 *     AI enrichment ─┤
 *     CSV import    ─┘
 *
 * Phase 3 implements manual entry only. Nothing else changes when the other
 * sources arrive — they populate the same structure.
 *
 * PER-FIELD PROVENANCE is the part that makes later phases possible without
 * rework. When AI proposes a region and the user corrects it, both are kept:
 * the proposal in `original`, the correction as the value. That is the
 * training signal Phase 10's enrichment review needs, and retrofitting it
 * would mean touching every source.
 */

import type { WineColour } from "./types";

export type DraftSource = "user" | "ai" | "photo" | "barcode" | "import" | "existing";

export interface FieldProvenance {
  source: DraftSource;
  /** 0–1 for automated sources. Null for user input, which is authoritative. */
  confidence: number | null;
  /** What an automated source proposed, if the user then overrode it. */
  original?: unknown;
  at: string;
}

/** The wine itself. */
export interface DraftIdentity {
  producer: string | null;
  name: string | null;
  vintage: number | null;
  colour: WineColour | null;
  grapes: string[];
  geoRegionId: string | null;
  countryCode: string | null;
  regionText: string | null;
  drinkFrom: number | null;
  drinkUntil: number | null;
  notes: string | null;
}

export type DraftField = keyof DraftIdentity;

/** Where the bottles are going. */
export interface DraftPlacement {
  storageLocationId: string | null;
  /** One entry per bottle. Null means unpositioned. */
  positions: (Record<string, number> | null)[];
}

/** What was paid, if known. */
export interface DraftAcquisition {
  purchasedOn: string | null;
  source: string | null;
  reference: string | null;
  unitPrice: number | null;
  currency: string;
  format: "case_12" | "case_6" | "case_3" | "loose";
  dutyPaid: boolean;
}

export interface WineDraft {
  identity: DraftIdentity;
  provenance: Partial<Record<DraftField, FieldProvenance>>;
  bottleSize: string;
  quantity: number;
  placement: DraftPlacement;
  acquisition: DraftAcquisition | null;
  /** Set when the user chose to add bottles to a wine they already own. */
  existingWineId: string | null;
}

// ── Construction ──────────────────────────────────────────────────────────

export function emptyDraft(): WineDraft {
  return {
    identity: {
      producer: null,
      name: null,
      vintage: null,
      colour: null,
      grapes: [],
      geoRegionId: null,
      countryCode: null,
      regionText: null,
      drinkFrom: null,
      drinkUntil: null,
      notes: null,
    },
    provenance: {},
    bottleSize: "750ml",
    quantity: 1,
    placement: { storageLocationId: null, positions: [null] },
    acquisition: null,
    existingWineId: null,
  };
}

/**
 * Set a field and record where the value came from.
 *
 * If an automated source had proposed something different, the proposal is
 * preserved in `original` rather than discarded.
 */
export function setField<K extends DraftField>(
  draft: WineDraft,
  field: K,
  value: DraftIdentity[K],
  source: DraftSource = "user",
  confidence: number | null = null,
): WineDraft {
  const previous = draft.provenance[field];
  const overridingAutomation = source === "user" && previous && previous.source !== "user";

  return {
    ...draft,
    identity: { ...draft.identity, [field]: value },
    provenance: {
      ...draft.provenance,
      [field]: {
        source,
        confidence: source === "user" ? null : confidence,
        ...(overridingAutomation ? { original: draft.identity[field] } : {}),
        at: new Date().toISOString(),
      },
    },
  };
}

/** Populate a draft from an automated source. Phase 10 onward. */
export function applySuggestions(
  draft: WineDraft,
  suggestions: Partial<DraftIdentity>,
  source: Exclude<DraftSource, "user">,
  confidence: number,
): WineDraft {
  let next = draft;
  for (const [key, value] of Object.entries(suggestions)) {
    const field = key as DraftField;
    // Never overwrite something the user typed.
    if (next.provenance[field]?.source === "user") continue;
    next = setField(next, field, value as never, source, confidence);
  }
  return next;
}

/** Which fields came from an automated source and still need review? */
export function fieldsNeedingReview(draft: WineDraft): DraftField[] {
  return (Object.keys(draft.provenance) as DraftField[]).filter((f) => {
    const p = draft.provenance[f];
    return p && p.source !== "user" && (p.confidence ?? 1) < 0.85;
  });
}

// ── Quantity and placement ────────────────────────────────────────────────

/** Changing quantity resizes the positions array to match, one per bottle. */
export function setQuantity(draft: WineDraft, quantity: number): WineDraft {
  const q = Math.max(1, Math.min(120, Math.floor(quantity)));
  const positions = Array.from(
    { length: q },
    (_, i) => draft.placement.positions[i] ?? null,
  );
  return { ...draft, quantity: q, placement: { ...draft.placement, positions } };
}

export function setLocation(draft: WineDraft, locationId: string | null): WineDraft {
  // A different location invalidates any positions chosen for the old one.
  return {
    ...draft,
    placement: {
      storageLocationId: locationId,
      positions: Array.from({ length: draft.quantity }, () => null),
    },
  };
}

export function setPosition(
  draft: WineDraft,
  index: number,
  position: Record<string, number> | null,
): WineDraft {
  const positions = [...draft.placement.positions];
  positions[index] = position;
  return { ...draft, placement: { ...draft.placement, positions } };
}

// ── Validation ────────────────────────────────────────────────────────────

export interface DraftValidation {
  valid: boolean;
  errors: Partial<Record<string, string>>;
}

export function validateIdentity(draft: WineDraft): DraftValidation {
  const errors: Record<string, string> = {};
  const { producer, name, vintage, colour, drinkFrom, drinkUntil } = draft.identity;

  if (!producer?.trim()) errors.producer = "Producer is required";
  if (!name?.trim()) errors.name = "Wine name is required";

  // Wine type is mandatory, and migration 016 refuses a wine without one.
  // It is checked HERE rather than on the first step because the control that
  // sets it lives on the Details step — validating it earlier would block the
  // user from ever reaching the field.
  if (!colour) errors.colour = "Wine type is required";

  const thisYear = new Date().getFullYear();
  if (vintage !== null) {
    if (!Number.isInteger(vintage) || vintage < 1800 || vintage > thisYear + 3) {
      errors.vintage = `Vintage must be between 1800 and ${thisYear + 3}`;
    }
  }
  if (drinkFrom !== null && drinkUntil !== null && drinkUntil < drinkFrom) {
    errors.drinkUntil = "Drink-until cannot be before drink-from";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export function validatePlacement(
  draft: WineDraft,
  layoutType: string | null,
): DraftValidation {
  const errors: Record<string, string> = {};

  // Any canonical <n>ml volume is valid; an unfinished or impossible custom
  // volume is caught here, before submission, not by the database.
  if (!isBottleSize(draft.bottleSize)) {
    errors.bottleSize = "Enter the bottle volume as a whole number of millilitres";
  }

  const positioned =
    layoutType !== null && !["unpositioned", "external"].includes(layoutType);

  if (draft.placement.storageLocationId && positioned) {
    draft.placement.positions.forEach((p, i) => {
      if (!p) errors[`position_${i}`] = `Bottle ${i + 1} needs a position`;
    });

    // Two bottles cannot go in the same slot.
    const seen = new Map<string, number>();
    draft.placement.positions.forEach((p, i) => {
      if (!p) return;
      const key = JSON.stringify(Object.entries(p).sort());
      const first = seen.get(key);
      if (first !== undefined) {
        errors[`position_${i}`] = `Same position as bottle ${first + 1}`;
      } else {
        seen.set(key, i);
      }
    });
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// ── Commit payload ────────────────────────────────────────────────────────

export interface CommitPayload {
  wine: Record<string, unknown> | null;
  wineDefinitionId: string | null;
  acquisition: Record<string, unknown>;
  items: Record<string, unknown>[];
}

/**
 * Convert a draft into arguments for create_acquisition_with_items.
 *
 * `items` is an ARRAY even though Phase 3's UI only ever produces one entry.
 * The RPC accepts many, so mixed acquisitions need UI work later but no
 * schema, domain or repository change.
 */
export function toCommitPayload(draft: WineDraft): CommitPayload {
  const { identity } = draft;

  const wine = draft.existingWineId
    ? null
    : {
        producer: identity.producer?.trim(),
        name: identity.name?.trim(),
        vintage: identity.vintage,
        colour: identity.colour,
        grapes: identity.grapes,
        geo_region_id: identity.geoRegionId,
        country_code: identity.countryCode,
        region_text: identity.regionText,
        drink_from: identity.drinkFrom,
        drink_until: identity.drinkUntil,
        notes: identity.notes,
        enrichment_source: "manual",
      };

  const a = draft.acquisition;

  return {
    wine,
    wineDefinitionId: draft.existingWineId,
    acquisition: {
      purchased_on: a?.purchasedOn ?? null,
      source: a?.source ?? null,
      reference: a?.reference ?? null,
      total_amount: a?.unitPrice != null ? a.unitPrice * draft.quantity : null,
      currency: a?.currency ?? "GBP",
      storage_location_id: draft.placement.storageLocationId,
    },
    items: [
      {
        quantity: draft.quantity,
        bottle_size: draft.bottleSize,
        format: a?.format ?? "loose",
        unit_price: a?.unitPrice ?? null,
        line_total: a?.unitPrice != null ? a.unitPrice * draft.quantity : null,
        duty_paid: a?.dutyPaid ?? true,
        storage_location_id: draft.placement.storageLocationId,
        positions: draft.placement.positions,
      },
    ],
  };
}

/** Is this a large transaction that should show as PENDING rather than optimistic? */
export function isLargeTransaction(draft: WineDraft): boolean {
  return (
    draft.quantity > 1 ||
    draft.existingWineId === null ||
    draft.placement.positions.some((p) => p !== null)
  );
}
