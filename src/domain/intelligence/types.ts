/**
 * Shared intelligence types.
 *
 * ── DESIGNED FOR LATER COMPOSITION ───────────────────────────────────────
 * Buying Intelligence is deferred, but a later phase must be able to combine
 * collection balance, drinking pressure, consumption behaviour, profile,
 * budget, acquisition history and valuation WITHOUT rewriting this engine.
 *
 * The shape that makes that possible is simply: every calculation is a pure
 * function taking raw domain data plus an optional profile, and returning a
 * typed result carrying its own evidence. No calculation reaches into React,
 * and none is coupled to how it will be displayed. That is sufficient — no
 * speculative abstraction has been added for a phase that may never need it.
 */

/**
 * The cellar's behavioural profile.
 *
 * Mirrors `cellar_profiles`. EVERY field is optional: migration 011 states
 * that intelligence must degrade gracefully rather than demand a
 * questionnaire before the app is usable.
 *
 * `favourite_regions` and `currency` are deliberately absent. They exist on
 * the table but `upsert_cellar_profile` cannot write them, and Phase 8 adds
 * no RPC. Exposing fields that silently fail to save would be worse than
 * omitting them.
 */
export interface CellarProfile {
  bottlesPerMonth: number | null;
  bottlesPurchasedPerYear: number | null;
  typicalPurchaseQuantity: number | null;
  prefersAgeing: boolean | null;
  collectingHorizonYears: number | null;
  favouriteGrapes: string[];
  dislikes: string[];
  typicalBottleBudget: number | null;
  valuesInvestment: boolean | null;
  onboardingCompletedAt: string | null;
  version: number;
}

export const emptyProfile = (): CellarProfile => ({
  bottlesPerMonth: null,
  bottlesPurchasedPerYear: null,
  typicalPurchaseQuantity: null,
  prefersAgeing: null,
  collectingHorizonYears: null,
  favouriteGrapes: [],
  dislikes: [],
  typicalBottleBudget: null,
  valuesInvestment: null,
  onboardingCompletedAt: null,
  version: 1,
});

/** True when the profile carries nothing intelligence can use. */
export function isProfileEmpty(p: CellarProfile | null): boolean {
  if (!p) return true;
  return (
    p.bottlesPerMonth === null &&
    p.bottlesPurchasedPerYear === null &&
    p.collectingHorizonYears === null &&
    p.typicalBottleBudget === null &&
    p.prefersAgeing === null &&
    p.valuesInvestment === null &&
    p.favouriteGrapes.length === 0 &&
    p.dislikes.length === 0
  );
}
