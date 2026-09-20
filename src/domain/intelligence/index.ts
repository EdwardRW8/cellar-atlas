/**
 * Intelligence composition.
 *
 * One pure entry point taking raw domain data plus an optional profile and
 * returning every result with its evidence attached. Nothing here touches
 * React, performs I/O, or knows how any of it will be displayed.
 *
 * That separation is what lets a later phase add Buying Intelligence by
 * combining these outputs — balance, pressure, consumption, profile — without
 * rewriting the engine. No abstraction has been added in advance for it.
 */

import type { WineSummary, DomainBottle } from "../types";
import { computeConsumptionCapacity, type ConsumptionCapacity } from "./consumption";
import {
  computeLongevity,
  computeLegacyOutlook,
  pastWindowBottles,
  type LongevityResult,
  type LegacyOutlookResult,
} from "./longevity";
import { computeConcentration, type ConcentrationDimension } from "./concentration";
import { isProfileEmpty, type CellarProfile } from "./types";

export interface CellarIntelligence {
  capacity: ConsumptionCapacity;
  longevity: LongevityResult;
  legacy: LegacyOutlookResult;
  concentration: ConcentrationDimension[];
  pastWindow: number;
  activeBottles: number;
  /** No active bottles at all. */
  isEmpty: boolean;
  /** Bottles exist but nothing can be projected — say why, do not guess. */
  hasProfile: boolean;
}

export function buildIntelligence(
  wines: WineSummary[],
  bottles: DomainBottle[],
  profile: CellarProfile | null,
  now: Date = new Date(),
): CellarIntelligence {
  const currentYear = now.getFullYear();
  const capacity = computeConsumptionCapacity(bottles, profile, now);

  const activeBottles = wines
    .filter((w) => w.activeBottles > 0)
    .reduce((n, w) => n + w.activeBottles, 0);

  return {
    capacity,
    longevity: computeLongevity(wines, capacity, currentYear),
    legacy: computeLegacyOutlook(wines, capacity, profile, currentYear),
    concentration: computeConcentration(wines),
    pastWindow: pastWindowBottles(wines, currentYear),
    activeBottles,
    isEmpty: activeBottles === 0,
    hasProfile: !isProfileEmpty(profile),
  };
}

export * from "./consumption";
export * from "./longevity";
export * from "./concentration";
export * from "./types";
