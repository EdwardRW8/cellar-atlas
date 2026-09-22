/** Shared domain types. camelCase, non-null where the domain guarantees it. */

export type WineColour = "Red" | "White" | "Rosé" | "Sparkling" | "Dessert" | "Fortified";

export type BottleStatus =
  "in_cellar" | "consumed" | "gifted" | "sold" | "lost" | "removed";

/** Any canonical `<n>ml` volume — see domain/bottle-size.ts. Not a closed list. */
export type { BottleSize } from "../bottle-size";
import type { BottleSize } from "../bottle-size";

export interface Money {
  amount: number;
  currency: string;
}

export interface GeoPath {
  country: { id: string; name: string; code: string } | null;
  region: { id: string; name: string } | null;
  appellation: { id: string; name: string } | null;
  /** Free text where no canonical node matched. */
  unmatched: string | null;
}

export interface DomainWine {
  id: string;
  producer: string;
  name: string;
  vintage: number | null;
  colour: WineColour | null;
  grapes: string[];
  geography: GeoPath;
  drinkFrom: number | null;
  drinkUntil: number | null;
  notes: string | null;
  version: number;
}

export interface DomainBottle {
  id: string;
  wineDefinitionId: string;
  acquisitionItemId: string | null;
  bottleSize: BottleSize;
  storageLocationId: string | null;
  position: Record<string, number> | null;
  positionKey: string | null;
  status: BottleStatus;
  statusChangedAt: string | null;
  currentValue: number | null;
  /**
   * When the cached value was written. Joins the bottle to the ledger row
   * that valued it, which is how its CURRENCY is discovered — `current_value`
   * carries none of its own.
   */
  currentValueAt: string | null;
  notes: string | null;
  version: number;
  isActive: boolean;
}

export interface DomainStorageLocation {
  id: string;
  name: string;
  kind: "home" | "merchant" | "fridge" | "other";
  layoutId: string | null;
  layoutType: string | null;
  layoutConfig: Record<string, unknown> | null;
  capacity: number | null;
  isExternal: boolean;
  isPositioned: boolean;
  occupied: number;
  version: number;
}

/** A wine plus its bottle roll-up, which is what the collection list shows. */
export interface WineSummary {
  wine: DomainWine;
  activeBottles: number;
  totalBottles: number;
  locations: { id: string; name: string; count: number }[];
  totalValue: number | null;
  /**
   * Valuation completeness for this wine's ACTIVE bottles.
   *
   * `totalValue` is a bare sum and cannot say how much of the holding it
   * covers. A wine with one valued bottle out of forty would otherwise read as
   * a confident total. This carries the counts so the UI can say so.
   */
  valuation: {
    valuedBottles: number;
    activeBottles: number;
  };
}
