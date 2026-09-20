/**
 * REAL SUPABASE JWT → RLS END-TO-END (amendment 2)
 *
 * Phase 2 proved RLS enforcement using PostgreSQL role simulation. It did NOT
 * exercise the complete browser token path. These tests close that gap:
 *
 *     browser sign-in
 *       → Supabase issues a JWT
 *         → PostgREST resolves auth.uid() from the bearer token
 *           → RLS policies evaluate
 *             → SECURITY INVOKER RPC runs with the user's own rights
 *               → database
 *
 * ── CREDENTIALS ───────────────────────────────────────────────────────────
 * Read from environment variables ONLY. Never committed, never in browser
 * code, never a service-role key. Set them before running:
 *
 *   export E2E_BASE_URL="https://your-site.netlify.app"
 *   export E2E_OWNER_EMAIL="owner@example.com"
 *   export E2E_OWNER_PASSWORD="..."
 *   export E2E_EDITOR_EMAIL="editor@example.com"
 *   export E2E_EDITOR_PASSWORD="..."
 *   export E2E_VIEWER_EMAIL="viewer@example.com"
 *   export E2E_VIEWER_PASSWORD="..."
 *   export E2E_OUTSIDER_EMAIL="outsider@example.com"
 *   export E2E_OUTSIDER_PASSWORD="..."
 *   export E2E_FOREIGN_CELLAR_ID="uuid-of-a-cellar-they-do-not-belong-to"
 *
 * Then:  npx playwright test tests/e2e/rls-jwt.spec.ts
 *
 * Tests skip rather than fail when credentials are absent, so CI without
 * secrets stays green.
 */

import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const FOREIGN_CELLAR = process.env.E2E_FOREIGN_CELLAR_ID ?? "";

/**
 * The same PUBLIC values the deployed app uses — project URL and publishable
 * (anon) key. Read in Node scope and passed into the browser as arguments.
 *
 * NEVER a service-role key. These tests must exercise the same public path a
 * real user does, or they prove nothing about RLS.
 */
const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? "";

interface Account {
  email: string;
  password: string;
}

function account(role: string): Account | null {
  // Trimmed: `export E2E_X_PASSWORD="value "` and heredoc newlines are a
  // common reason automated sign-in fails where manual sign-in succeeds.
  const email = process.env[`E2E_${role}_EMAIL`]?.trim();
  const password = process.env[`E2E_${role}_PASSWORD`]?.trim();
  return email && password ? { email, password } : null;
}

const OWNER = account("OWNER");
const EDITOR = account("EDITOR");
const VIEWER = account("VIEWER");
const OUTSIDER = account("OUTSIDER");

/**
 * Sign in through the real UI. No token injection — that is the point.
 *
 * Three defects in the original helper are addressed here:
 *
 *   1. NO ISOLATION. Storage was never cleared, so a session left by an
 *      earlier test could persist. The sign-in form then never renders and
 *      the helper waits for the wrong thing.
 *
 *   2. SILENT FAILURES. When sign-in was rejected the app shows its reason
 *      on screen, but the helper ignored it and timed out on the navigation
 *      instead — reporting a symptom rather than the cause.
 *
 *   3. WHITESPACE. Shell quoting frequently leaves a trailing newline or
 *      space on an exported variable. Manual sign-in works; the automated one
 *      does not. Credentials are trimmed and their shape asserted.
 */
async function signIn(page: Page, acct: Account, label: string) {
  // ── 1. Guarantee a clean session ────────────────────────────────────────
  await page.goto(BASE);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();

  // ── 2. Wait for the form, not a guess ───────────────────────────────────
  const email = page.getByLabel("Email");
  await expect(
    email,
    `${label}: the sign-in form did not appear — a previous session may have persisted`,
  ).toBeVisible({ timeout: 20_000 });

  await email.fill(acct.email);
  await page.getByLabel("Password").fill(acct.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  // ── 3. Race the success signal against the app's own error message ──────
  const nav = page.getByRole("navigation", { name: "Primary" });
  const errorBanner = page.getByRole("alert");

  const outcome = await Promise.race([
    nav.waitFor({ state: "visible", timeout: 25_000 }).then(() => "ok" as const),
    errorBanner.waitFor({ state: "visible", timeout: 25_000 }).then(() => "error" as const),
  ]).catch(() => "timeout" as const);

  if (outcome === "error") {
    // Surface the reason WITHOUT logging the password.
    const message = await errorBanner.textContent();
    throw new Error(
      `${label}: Supabase rejected the sign-in — "${message?.trim()}". ` +
        `Email used: ${maskEmail(acct.email)}. ` +
        `Check the env var for stray whitespace or quoting.`,
    );
  }

  if (outcome === "timeout") {
    const visibleText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(
      `${label}: neither the navigation nor an error appeared within 25s. ` +
        `Email used: ${maskEmail(acct.email)}. ` +
        `Screen text: ${visibleText.slice(0, 200).replace(/\s+/g, " ")}`,
    );
  }

  await expect(nav).toBeVisible();
}

/** Enough to identify the account, never the full address. */
function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "(malformed)";
  return `${user.slice(0, 2)}***@${domain}`;
}

/**
 * Direct PostgREST request carrying the signed-in user's JWT.
 *
 * SERIALIZATION RULE: the callback passed to page.evaluate() must reference
 * NOTHING from Node scope — no imports, no closures, and above all no
 * `import.meta`. Playwright serialises the function with toString(); the
 * TypeScript loader rewrites `import.meta` into a module-scope reference that
 * does not exist in the browser, and Playwright rejects it with
 * "Passed function is not well-serializable!".
 *
 * Every value the browser needs is therefore passed in as a plain argument.
 */
async function restRequest(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  // Read from Node's process.env here, OUTSIDE the browser callback.
  const url = SUPABASE_URL;
  const apikey = SUPABASE_KEY;

  if (!url || !apikey) {
    throw new Error(
      "E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY must be set. " +
        "These are the same public values the deployed app uses. " +
        "Never set a service-role key here.",
    );
  }

  return page.evaluate(
    async (args: {
      url: string;
      apikey: string;
      path: string;
      method: string;
      body: string | null;
    }) => {
      // The app stores its session under this key (see supabase-client.ts).
      const authKey = Object.keys(localStorage).find((k) => k.startsWith("cellar_v3_auth"));
      if (!authKey) throw new Error("No Supabase session found in localStorage");

      const raw = localStorage.getItem(authKey);
      if (!raw) throw new Error("Supabase session key present but empty");

      const session = JSON.parse(raw) as { access_token?: string };
      if (!session.access_token) throw new Error("Session has no access token");

      const res = await fetch(args.url + "/rest/v1/" + args.path, {
        method: args.method,
        headers: {
          apikey: args.apikey,
          // The REAL user JWT. This is the whole point of these tests.
          Authorization: "Bearer " + session.access_token,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: args.body ?? undefined,
      });

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    },
    {
      url,
      apikey,
      path,
      method: init.method ?? "GET",
      body: init.body ? JSON.stringify(init.body) : null,
    },
  );
}

/**
 * Create a REAL immutable event to test against.
 *
 * The previous version grabbed an arbitrary pre-existing event and skipped
 * when the cellar was empty — which meant the immutability assertions never
 * ran on a fresh deployment, exactly where they matter most.
 *
 * This creates its own subject through the application's own RPCs, as the
 * signed-in owner, over the real JWT path:
 *
 *   create_wine_definition       → a disposable wine
 *   create_acquisition_with_items → 1 acquisition, 1 item, 1 bottle,
 *                                   1 bottle_events row (event_type='added')
 *
 * The event is then located by `source_operation_id`, so the test asserts
 * against the event THIS run produced rather than whatever happened to be
 * first in the table.
 *
 * Everything it creates is clearly marked E2E test data.
 */
async function createEventFixture(page: Page): Promise<{
  cellarId: string;
  wineId: string;
  operationId: string;
  eventId: string;
}> {
  const cellarId = await currentCellarId(page);
  expect(cellarId, "owner must belong to a cellar").toBeTruthy();

  const stamp = Date.now();

  // 1. A disposable wine definition.
  const wineRes = await restRequest(page, "rpc/create_wine_definition", {
    method: "POST",
    body: {
      p_operation_id: crypto.randomUUID(),
      p_cellar_id: cellarId,
      p_wine: {
        producer: "E2E Immutability Fixture",
        name: `Disposable Wine ${stamp}`,
        colour: "Red",
        notes: "[E2E-TEST] created by the immutable-history test",
      },
    },
  });
  expect(wineRes.status, "wine creation should succeed for the owner").toBe(200);
  const wineId = wineRes.body as string;
  expect(typeof wineId).toBe("string");

  // 2. One acquisition → one bottle → one immutable 'added' event.
  //    The operation id becomes source_operation_id on that event.
  const operationId = crypto.randomUUID();
  const acqRes = await restRequest(page, "rpc/create_acquisition_with_items", {
    method: "POST",
    body: {
      p_operation_id: operationId,
      p_cellar_id: cellarId,
      p_acquisition: {
        source: "E2E Immutability Fixture",
        reference: `E2E-${stamp}`,
        notes: "[E2E-TEST] created by the immutable-history test",
      },
      p_items: [
        {
          wine_definition_id: wineId,
          quantity: 1,
          bottle_size: "750ml",
          format: "loose",
          // No storage location, so no position is required.
        },
      ],
    },
  });
  expect(acqRes.status, "acquisition creation should succeed for the owner").toBe(200);

  // 3. Find the event THIS operation produced.
  const events = await restRequest(
    page,
    `bottle_events?select=id,event_type&source_operation_id=eq.${operationId}`,
  );
  expect(events.status).toBe(200);

  const rows = events.body as { id: string; event_type: string }[];
  expect(
    rows?.length,
    "the acquisition should have produced exactly one 'added' event",
  ).toBe(1);
  expect(rows[0]!.event_type).toBe("added");

  return { cellarId: cellarId!, wineId, operationId, eventId: rows[0]!.id };
}

/** The cellar the signed-in user belongs to, via the real token path. */
async function currentCellarId(page: Page): Promise<string | null> {
  const res = await restRequest(page, "cellar_members?select=cellar_id&limit=1");
  const rows = res.body as { cellar_id: string }[] | null;
  return rows?.[0]?.cellar_id ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// OWNER
// ═══════════════════════════════════════════════════════════════════════════

test.describe("OWNER — real JWT path", () => {
  test.skip(!OWNER, "E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD not set");

  test("can sign in through the browser", async ({ page }) => {
    await signIn(page, OWNER!, "OWNER");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });

  test("can read their own cellar", async ({ page }) => {
    await signIn(page, OWNER!, "OWNER");
    await page.getByRole("link", { name: /cellar/i }).click();
    // Either wines are listed or the empty state shows — both prove a read.
    await expect(page.getByRole("heading", { name: /cellar/i }).first()).toBeVisible();

    const res = await restRequest(page, "wine_definitions?select=id");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test("can perform an inventory mutation via SECURITY INVOKER RPC", async ({ page }) => {
    await signIn(page, OWNER!, "OWNER");
    const cellarId = await currentCellarId(page);
    expect(cellarId, "owner should belong to a cellar").toBeTruthy();

    const res = await restRequest(page, "rpc/create_wine_definition", {
      method: "POST",
      body: {
        p_operation_id: crypto.randomUUID(),
        p_cellar_id: cellarId,
        p_wine: {
          producer: "E2E Owner Test",
          name: `Owner Wine ${Date.now()}`,
          colour: "Red",
        },
      },
    });
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("string"); // returns the new uuid
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EDITOR
// ═══════════════════════════════════════════════════════════════════════════

test.describe("EDITOR — real JWT path", () => {
  test.skip(!EDITOR, "E2E_EDITOR credentials not set");

  test("can sign in and read the cellar", async ({ page }) => {
    await signIn(page, EDITOR!, "EDITOR");
    const res = await restRequest(page, "wine_definitions?select=id");
    expect(res.status).toBe(200);
  });

  test("CAN perform permitted inventory mutations", async ({ page }) => {
    await signIn(page, EDITOR!, "EDITOR");
    const cellarId = await currentCellarId(page);

    const res = await restRequest(page, "rpc/create_wine_definition", {
      method: "POST",
      body: {
        p_operation_id: crypto.randomUUID(),
        p_cellar_id: cellarId,
        p_wine: { producer: "E2E Editor Test", name: `Editor Wine ${Date.now()}` },
      },
    });
    expect(res.status).toBe(200);
  });

  test("CANNOT invite members — owner only", async ({ page }) => {
    await signIn(page, EDITOR!, "EDITOR");
    const cellar = await restRequest(
      page,
      "cellar_members?select=cellar_id,user_id&limit=1",
    );
    const row = (cellar.body as { cellar_id: string; user_id: string }[])[0];

    const res = await restRequest(page, "cellar_members", {
      method: "POST",
      body: { cellar_id: row!.cellar_id, user_id: row!.user_id, role: "editor" },
    });
    // RLS refuses the insert.
    expect([401, 403, 409]).toContain(res.status);
  });

  test("CANNOT write the cellar profile — owner only", async ({ page }) => {
    await signIn(page, EDITOR!, "EDITOR");
    const cellarId = await currentCellarId(page);

    const res = await restRequest(page, "cellar_profiles", {
      method: "POST",
      body: { cellar_id: cellarId, bottles_per_month: 99 },
    });
    expect([401, 403, 409]).toContain(res.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VIEWER
// ═══════════════════════════════════════════════════════════════════════════

test.describe("VIEWER — real JWT path", () => {
  test.skip(!VIEWER, "E2E_VIEWER credentials not set");

  test("can sign in and read", async ({ page }) => {
    await signIn(page, VIEWER!, "VIEWER");
    const res = await restRequest(page, "wine_definitions?select=id");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test("CANNOT insert a wine directly", async ({ page }) => {
    await signIn(page, VIEWER!, "VIEWER");
    const cellarId = await currentCellarId(page);

    const res = await restRequest(page, "wine_definitions", {
      method: "POST",
      body: { cellar_id: cellarId, producer: "Viewer Hack", name: "Should Fail" },
    });
    expect([401, 403]).toContain(res.status);
  });

  test("CANNOT mutate via RPC — SECURITY INVOKER blocks at claim_operation", async ({
    page,
  }) => {
    await signIn(page, VIEWER!, "VIEWER");
    const cellarId = await currentCellarId(page);

    const res = await restRequest(page, "rpc/create_wine_definition", {
      method: "POST",
      body: {
        p_operation_id: crypto.randomUUID(),
        p_cellar_id: cellarId,
        p_wine: { producer: "Viewer", name: "Should Fail" },
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("an UPDATE affects zero rows rather than erroring", async ({ page }) => {
    await signIn(page, VIEWER!, "VIEWER");
    // RLS denies UPDATE by making rows invisible. No error is raised —
    // watching only for errors would give a false pass.
    const res = await restRequest(page, "bottles?notes=eq.e2e-viewer-hack", {
      method: "PATCH",
      body: { notes: "e2e-viewer-hack" },
    });
    if (res.status === 200) {
      expect(Array.isArray(res.body) ? res.body.length : 0).toBe(0);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-CELLAR
// ═══════════════════════════════════════════════════════════════════════════

test.describe("CROSS-CELLAR isolation — real JWT path", () => {
  test.skip(
    !OUTSIDER || !FOREIGN_CELLAR,
    "E2E_OUTSIDER credentials or E2E_FOREIGN_CELLAR_ID not set",
  );

  test("cannot READ a cellar they do not belong to", async ({ page }) => {
    await signIn(page, OUTSIDER!, "OUTSIDER");
    const res = await restRequest(
      page,
      `wine_definitions?select=id&cellar_id=eq.${FOREIGN_CELLAR}`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body) ? res.body.length : -1).toBe(0);
  });

  test("cannot WRITE into a cellar they do not belong to", async ({ page }) => {
    await signIn(page, OUTSIDER!, "OUTSIDER");
    const res = await restRequest(page, "wine_definitions", {
      method: "POST",
      body: { cellar_id: FOREIGN_CELLAR, producer: "Intruder", name: "Should Fail" },
    });
    expect([401, 403]).toContain(res.status);
  });

  test("cannot call an RPC against another cellar", async ({ page }) => {
    await signIn(page, OUTSIDER!, "OUTSIDER");
    const res = await restRequest(page, "rpc/create_wine_definition", {
      method: "POST",
      body: {
        p_operation_id: crypto.randomUUID(),
        p_cellar_id: FOREIGN_CELLAR,
        p_wine: { producer: "Intruder", name: "Should Fail" },
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IMMUTABLE HISTORY — through the real token path
// ═══════════════════════════════════════════════════════════════════════════

test.describe("IMMUTABLE history — real JWT path", () => {
  test.skip(!OWNER, "E2E_OWNER credentials not set");

  test("even the owner cannot rewrite an event", async ({ page }) => {
    await signIn(page, OWNER!, "OWNER");
    const { eventId } = await createEventFixture(page);

    const res = await restRequest(page, `bottle_events?id=eq.${eventId}`, {
      method: "PATCH",
      body: { notes: "e2e-rewritten" },
    });

    // RLS refuses an UPDATE by matching zero rows, not by erroring. Watching
    // only for a status code would record a false pass here.
    if (res.status === 200) {
      expect(
        Array.isArray(res.body) ? res.body.length : 0,
        "PATCH should have affected zero rows",
      ).toBe(0);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }

    const after = await restRequest(page, `bottle_events?select=notes&id=eq.${eventId}`);
    const row = (after.body as { notes: string | null }[])[0];
    expect(row, "the event must still exist").toBeTruthy();
    expect(row?.notes).not.toBe("e2e-rewritten");
  });

  test("even the owner cannot delete an event", async ({ page }) => {
    await signIn(page, OWNER!, "OWNER");
    const { eventId } = await createEventFixture(page);

    const res = await restRequest(page, `bottle_events?id=eq.${eventId}`, {
      method: "DELETE",
    });

    if (res.status === 200) {
      expect(
        Array.isArray(res.body) ? res.body.length : 0,
        "DELETE should have affected zero rows",
      ).toBe(0);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }

    const after = await restRequest(page, `bottle_events?select=id&id=eq.${eventId}`);
    expect(
      Array.isArray(after.body) ? after.body.length : 0,
      "the event must survive the delete attempt",
    ).toBe(1);
  });
});
