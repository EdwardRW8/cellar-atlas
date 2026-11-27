/**
 * EVERY SENTENCE THE APP SAYS ABOUT A CHANGE IT CANNOT MAKE OR CANNOT CONFIRM.
 *
 * These were previously spread across the entry points, and two kinds of
 * dishonesty crept in:
 *
 *   1. One message for four different situations. `canMutate` is a single
 *      boolean covering offline, view-only, permission-check-in-progress and
 *      permission-check-failed, and every screen rendered all four as
 *      "You're offline." An online viewer was told to check their connection.
 *
 *   2. A guarantee where there was only a guess. A failed request was always
 *      reported as "Nothing was recorded", which is true when the server
 *      answered no and unknowable when the request never came back.
 *
 * This module is deliberately pure and React-free, so the classification can
 * be tested directly and cannot drift from what the UI renders.
 */

/** Why loading failed, when it did. */
export type LoadErrorKind = "permission" | "network" | "unknown";

/**
 * Has this user's role been established?
 *
 * "unknown" before the check completes, "failed" when it could not be read.
 * NEITHER enables writes: the UI must not offer a control whose permission it
 * was unable to confirm.
 */
export type PermissionState = "unknown" | "known" | "failed";

/** Classify a failure WITHOUT guessing: anything unrecognised stays unknown. */
export function classifyLoadError(message: string): LoadErrorKind {
  const m = message.toLowerCase();
  if (
    /row-level security|row level security|permission denied|not authorized|jwt|forbidden/.test(
      m,
    )
  )
    return "permission";
  if (/failed to fetch|network|offline|timeout|econn|unreachable/.test(m)) return "network";
  return "unknown";
}

/**
 * The one sentence shown wherever a change cannot be attempted offline.
 * Kept here so every entry point says exactly the same thing.
 */
export const OFFLINE_REASON = "You're offline. Changes need a connection.";

/**
 * Shown when the server ANSWERED, and its answer was no.
 *
 * Only correct where that is actually known. Nothing reached the database, so
 * there is nothing to check and nothing to undo: trying again is the whole
 * remedy.
 */
export const NOT_SAVED =
  "Not saved. Nothing was recorded — check your connection and try again.";

/**
 * Shown when the outcome is genuinely UNKNOWN.
 *
 * A request that never came back proves nothing. The mutation may have been
 * committed and only the response lost, so "nothing was recorded" would be a
 * guess presented as a guarantee — and a user who believed it would act on
 * it, most likely by repeating a change that had already gone through.
 *
 * Nor may this promise that trying again is harmless. A replay IS harmless
 * when the operation id is stable, because `claim_operation` recognises it —
 * but only the CSV importer supplies one. Every ordinary screen mutation
 * generates a fresh id per call, so a second press is a second operation the
 * server has no way to match to the first. Hence: check, then decide.
 */
export const NOT_CONFIRMED =
  "We couldn't reach the server, so we don't know whether this was saved. Refresh to check before trying again, because trying again could repeat it.";

/**
 * The right message for a failed mutation.
 *
 * Classified on the same rules as a load failure, because the question is the
 * same one: did the server answer? A rejection is reported in the server's own
 * words, which are specific and true. A lost or unreachable request becomes
 * NOT_CONFIRMED rather than a false guarantee, or a raw "Failed to fetch" the
 * user can do nothing with.
 */
export function mutationFailureMessage(error?: string | null): string {
  if (!error) return NOT_SAVED;
  return classifyLoadError(error) === "network" ? NOT_CONFIRMED : error;
}

/**
 * WHY a change cannot be attempted right now.
 *
 * Four separate situations that `canMutate` collapses into one `false`. They
 * need different words, and exactly one of them has a retry worth offering.
 */
export type MutationBlock = "offline" | "checking" | "permission-failed" | "read-only";

export const MUTATION_BLOCK_MESSAGE: Record<MutationBlock, string> = {
  offline: OFFLINE_REASON,
  checking: "Checking what you can change…",
  "permission-failed":
    "We couldn't check what you're allowed to change, so changes are turned off.",
  "read-only": "You have view-only access to this cellar.",
};

/**
 * Which of the four applies, or null when a change may be attempted.
 *
 * ORDER MATTERS, and it is not arbitrary:
 *
 *   offline first — it is the only one of these that explains ALL the others
 *     while it holds. With no connection the permission check cannot have
 *     succeeded and cannot be retried, so naming anything else would send the
 *     user after the wrong problem.
 *   permission-failed before checking — "failed" is a settled outcome, and
 *     the only state with a recovery action attached.
 *   read-only last — reached only when the role is CONFIRMED and is neither
 *     owner nor editor. Reporting view-only access on an unconfirmed role
 *     would be the same guess, in the other direction.
 *
 * This returns null under exactly the conditions where `canMutate` is true.
 * That agreement is asserted over the whole cross-product in
 * tests/unit/mutation-messaging.test.ts: if the two ever diverge, a control
 * is either disabled with no explanation or explained while still enabled.
 */
export function mutationBlock(cellar: {
  online: boolean;
  permissionState: PermissionState;
  role: string | null;
}): MutationBlock | null {
  if (!cellar.online) return "offline";
  if (cellar.permissionState === "failed") return "permission-failed";
  if (cellar.permissionState === "unknown") return "checking";
  if (cellar.role !== "owner" && cellar.role !== "editor") return "read-only";
  return null;
}

/**
 * The message for a blocked control, or null when nothing blocks it.
 * A convenience over the two above, so no caller has to pair them by hand.
 */
export function mutationBlockMessage(cellar: {
  online: boolean;
  permissionState: PermissionState;
  role: string | null;
}): string | null {
  const block = mutationBlock(cellar);
  return block ? MUTATION_BLOCK_MESSAGE[block] : null;
}
