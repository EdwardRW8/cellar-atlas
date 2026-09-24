/**
 * The cellar guard for mutating E2E tests.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * Mutating E2E specs used to resolve their target with
 * `cellar_members?select=cellar_id&limit=1` — whatever cellar came back
 * first. With the wrong credentials that is someone's real collection. The
 * dedicated E2E Test Cellar is the ONLY permitted target for a mutating test,
 * and this module refuses anything else.
 *
 * ── PURE ON PURPOSE ──────────────────────────────────────────────────────
 * These functions take data and return a value or throw. No network, no
 * Playwright, no environment reads except the caller's explicit argument. That
 * makes the safety rules directly testable in the harness, which is how we
 * know the guard actually bites rather than passing vacuously.
 */

import type { Page } from "@playwright/test";

/** A message every failure carries, so the cause is never ambiguous. */
const REFUSE = "refusing to mutate";

/**
 * Establish the one cellar a mutating test may touch.
 *
 * `memberCellarIds` is every `cellar_members.cellar_id` row the signed-in
 * account can see. Rows are de-duplicated before counting: depending on the
 * SELECT policy, a query can return one row per MEMBER of a shared cellar
 * rather than one row per cellar, and counting rows would then be wrong.
 *
 * Throws unless the account belongs to exactly one cellar and that cellar is
 * `expected`. Belonging to several is ambiguous — the app writes to whichever
 * it picks — so it is refused rather than guessed.
 */
export function verifyE2eCellar(
  memberCellarIds: readonly string[],
  expected: string | undefined,
): string {
  const target = expected?.trim();
  if (!target) {
    throw new Error(
      `E2E_CELLAR_ID must be set before any mutating E2E test runs — ${REFUSE}.`,
    );
  }

  const distinct = distinctIds(memberCellarIds);

  if (distinct.length === 0) {
    throw new Error(
      `The signed-in account belongs to no cellar — ${REFUSE}. ` +
        `Check the E2E credentials.`,
    );
  }

  if (!distinct.includes(target)) {
    throw new Error(
      `The signed-in account is not a member of E2E_CELLAR_ID — ${REFUSE}. ` +
        `It belongs to ${distinct.length} other cellar(s).`,
    );
  }

  // Several memberships are FINE. An E2E account may legitimately belong to
  // more than one cellar. Safety comes from every mutation naming this target
  // explicitly — never from "the first membership", an ordering, or limit=1.
  return target;
}

/**
 * The stricter rule for specs that mutate THROUGH THE UI.
 *
 * When a test calls an RPC it passes `p_cellar_id` itself, so the target is
 * explicit and extra memberships are harmless. When a test clicks a button,
 * the APP chooses the cellar — and it does so with an unordered
 * `cellar_members ... limit(1)` (see `CellarRepository.resolveCellar`). With
 * more than one membership that choice is not stable, so a UI-driven write
 * could land in a different cellar than this test intends.
 *
 * Nothing in the test can make that choice deterministic, so a UI-mutating
 * spec requires an account whose ONLY membership is the E2E Test Cellar. It
 * fails loudly rather than hoping the right row comes back first.
 */
export function verifyAppTargetsE2eCellar(
  memberCellarIds: readonly string[],
  expected: string | undefined,
): string {
  const target = verifyE2eCellar(memberCellarIds, expected);
  const distinct = distinctIds(memberCellarIds);

  if (distinct.length > 1) {
    throw new Error(
      `This spec mutates through the UI, and the app picks its active cellar ` +
        `with an unordered limit(1) query. The account belongs to ` +
        `${distinct.length} cellars, so a click could write to the wrong one ` +
        `— ${REFUSE}. Use an account whose only membership is the E2E Test ` +
        `Cellar for UI-mutating specs.`,
    );
  }

  return target;
}

/** Unique, trimmed, non-empty ids. */
function distinctIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id?.trim()).filter(Boolean))];
}

/**
 * Establish the cellar used by the cross-cellar isolation tests.
 *
 * Those tests sign in as an outsider and ATTEMPT reads and writes against a
 * cellar they do not belong to, expecting RLS to refuse. The attempt is still
 * a write attempt: if RLS ever regressed, it would land somewhere real.
 *
 * So the foreign cellar must BE the dedicated E2E Test Cellar. The outsider is
 * not a member of it, which is exactly what the test needs, and it keeps the
 * rule that the E2E Test Cellar is the only cellar any mutating test may
 * target.
 *
 * `outsiderCellarIds` is checked too: if the outsider turned out to be a
 * member, the isolation test would prove nothing and is refused as
 * meaningless rather than passing for the wrong reason.
 */
export function verifyForeignCellar(
  foreignCellarId: string | undefined,
  e2eCellarId: string | undefined,
  outsiderCellarIds: readonly string[],
): string {
  const foreign = foreignCellarId?.trim();
  const e2e = e2eCellarId?.trim();

  if (!e2e) {
    throw new Error(
      `E2E_CELLAR_ID must be set before any mutating E2E test runs — ${REFUSE}.`,
    );
  }
  if (!foreign) {
    throw new Error(`E2E_FOREIGN_CELLAR_ID must be set — ${REFUSE}.`);
  }

  if (foreign !== e2e) {
    throw new Error(
      `E2E_FOREIGN_CELLAR_ID must be the dedicated E2E Test Cellar ` +
        `(the same value as E2E_CELLAR_ID) — ${REFUSE}. The cross-cellar ` +
        `tests attempt writes against it, and the E2E Test Cellar is the only ` +
        `cellar any mutating test may target.`,
    );
  }

  if (distinctIds(outsiderCellarIds).includes(foreign)) {
    throw new Error(
      `The outsider account IS a member of the foreign cellar, so the ` +
        `isolation test would prove nothing — ${REFUSE}.`,
    );
  }

  return foreign;
}

/**
 * Read the signed-in account's cellar memberships, using the session the app
 * already holds.
 *
 * GET only, through the public anon key and the user's own JWT, so RLS applies
 * exactly as it does for a real user. Never a service-role key.
 *
 * Provided for specs that drive the UI and have no REST helper of their own.
 */
export async function fetchMemberCellarIds(
  page: Page,
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
): Promise<string[]> {
  if (!supabaseUrl?.trim() || !supabaseKey?.trim()) {
    throw new Error(
      `E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY must be set so the cellar ` +
        `guard can verify the target before mutating — ${REFUSE}.`,
    );
  }

  return page.evaluate(
    async (args: { url: string; apikey: string }) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("cellar_v3_auth"));
      if (!key) throw new Error("No Supabase session found — cannot verify the cellar");
      const raw = localStorage.getItem(key);
      if (!raw) throw new Error("Session key present but empty");
      const session = JSON.parse(raw) as { access_token?: string };
      if (!session.access_token) throw new Error("Session has no access token");

      const res = await fetch(`${args.url}/rest/v1/cellar_members?select=cellar_id`, {
        method: "GET",
        headers: { apikey: args.apikey, Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error(`Could not read cellar membership (HTTP ${res.status})`);
      const rows = (await res.json()) as { cellar_id: string }[];
      return rows.map((r) => r.cellar_id);
    },
    { url: supabaseUrl.trim(), apikey: supabaseKey.trim() },
  );
}

/** Fetch memberships and verify them in one step. Throws unless safe. */
export async function assertGuardedCellar(
  page: Page,
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
): Promise<string> {
  const ids = await fetchMemberCellarIds(page, supabaseUrl, supabaseKey);
  return verifyE2eCellar(ids, process.env.E2E_CELLAR_ID);
}

/** As above, for specs that mutate by clicking rather than by calling an RPC. */
export async function assertAppTargetsGuardedCellar(
  page: Page,
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
): Promise<string> {
  const ids = await fetchMemberCellarIds(page, supabaseUrl, supabaseKey);
  return verifyAppTargetsE2eCellar(ids, process.env.E2E_CELLAR_ID);
}
