/**
 * HOME DASHBOARD — LIVE ACCEPTANCE
 *
 * Additive. Every existing Phase 3/4/5 assertion is untouched.
 *
 * Home is the default route, so it loads on every launch — these checks
 * matter more than most.
 */

import { test, expect, devices, type Page } from "@playwright/test";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const EMAIL = process.env.E2E_OWNER_EMAIL?.trim();
const PASSWORD = process.env.E2E_OWNER_PASSWORD?.trim();

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? "";

test.use({ ...devices["iPhone 13"] });

/**
 * Wait for useCellar to finish loading.
 *
 * The heading renders immediately in every state — loading, error and ready —
 * so waiting for it proves nothing about the data. The skeleton carries
 * role="status" aria-label="Loading" and is removed once state leaves
 * "loading", which is the actual signal. No fixed delay is used.
 */
async function waitForHomeLoaded(page: Page) {
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible({
    timeout: 25_000,
  });
  await expect(
    page.getByRole("status", { name: /loading/i }),
    "Home should finish loading",
  ).toHaveCount(0, { timeout: 25_000 });
}

/** Authenticated REST call using the session the app already holds. */
async function restRequest(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      "E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY must be set — the same " +
        "public values the deployed app uses. Never a service-role key.",
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
      const authKey = Object.keys(localStorage).find((k) => k.startsWith("cellar_v3_auth"));
      if (!authKey) throw new Error("No Supabase session found");
      const raw = localStorage.getItem(authKey);
      if (!raw) throw new Error("Session key present but empty");
      const session = JSON.parse(raw) as { access_token?: string };
      if (!session.access_token) throw new Error("Session has no access token");

      const res = await fetch(args.url + "/rest/v1/" + args.path, {
        method: args.method,
        headers: {
          apikey: args.apikey,
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
      url: SUPABASE_URL,
      apikey: SUPABASE_KEY,
      path,
      method: init.method ?? "GET",
      body: init.body ? JSON.stringify(init.body) : null,
    },
  );
}

/**
 * Seed one wine that is unambiguously ready to drink, so the Ready panel is
 * present regardless of what the cellar happens to contain.
 *
 * Uses the application's own RPCs over the real JWT path. Marked
 * [E2E-TEST] so the rows are identifiable.
 */
async function seedReadyWine(page: Page): Promise<string> {
  const cellar = await restRequest(page, "cellar_members?select=cellar_id&limit=1");
  const cellarId = (cellar.body as { cellar_id: string }[])[0]?.cellar_id;
  expect(cellarId, "owner must belong to a cellar").toBeTruthy();

  // ── CELLAR SAFETY ──────────────────────────────────────────────────────
  // This test WRITES. It must never touch the owner's real cellar, so the
  // dedicated E2E cellar is required explicitly and asserted before any
  // mutation. Failing here is far better than seeding fixture wine into a
  // real collection.
  const expected = process.env.E2E_CELLAR_ID?.trim();
  expect(
    expected,
    "E2E_CELLAR_ID must be set before any mutating E2E test runs",
  ).toBeTruthy();
  expect(
    cellarId,
    "resolved cellar is not the dedicated E2E cellar — refusing to mutate",
  ).toBe(expected);

  const year = new Date().getFullYear();
  const name = `E2E Ready Wine ${Date.now()}`;

  const wineRes = await restRequest(page, "rpc/create_wine_definition", {
    method: "POST",
    body: {
      p_operation_id: crypto.randomUUID(),
      p_cellar_id: cellarId,
      p_wine: {
        producer: "E2E Home Fixture",
        name,
        colour: "Red",
        // Comfortably open now, and far from closing, so this wine lands in
        // "Ready to drink" and NOT in "Closing soon".
        drink_from: year - 5,
        drink_until: year + 20,
        notes: "[E2E-TEST] created by the Home dashboard test",
      },
    },
  });
  expect(wineRes.status, "wine creation should succeed").toBe(200);

  const acqRes = await restRequest(page, "rpc/create_acquisition_with_items", {
    method: "POST",
    body: {
      p_operation_id: crypto.randomUUID(),
      p_cellar_id: cellarId,
      p_acquisition: {
        source: "E2E Home Fixture",
        notes: "[E2E-TEST] created by the Home dashboard test",
      },
      p_items: [
        {
          wine_definition_id: wineRes.body as string,
          quantity: 1,
          bottle_size: "750ml",
          format: "loose",
        },
      ],
    },
  });
  expect(acqRes.status, "acquisition creation should succeed").toBe(200);

  return name;
}

test.describe("home dashboard", () => {
  test.skip(!EMAIL || !PASSWORD, "E2E_OWNER credentials not set");

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const RULE =
        '#nl-badge-frame, iframe[title="Powered by Netlify"] ' +
        "{ pointer-events: none !important; }";
      const install = () => {
        if (document.getElementById("e2e-badge-neutraliser")) return;
        const style = document.createElement("style");
        style.id = "e2e-badge-neutraliser";
        style.textContent = RULE;
        document.head.appendChild(style);
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", install, { once: true });
      } else {
        install();
      }
    });

    await page.goto(BASE);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();

    await expect(page.getByLabel("Email")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Email").fill(EMAIL!);
    await page.getByLabel("Password").fill(PASSWORD!);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
      timeout: 25_000,
    });
  });

  test("Home is the default route after sign-in", async ({ page }) => {
    await expect(page).toHaveURL(
      new RegExp(`${BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`),
    );
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  });

  test("Home shows real data, not a placeholder", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

    // Either real content or the designed empty state — never the old
    // "Nothing to report yet" placeholder.
    await expect(page.getByText(/nothing to report yet/i)).toHaveCount(0);

    const hasBottles = await page.getByText(/\d+ bottles? · \d+ wines?/).count();
    const isEmpty = await page.getByText(/your cellar is empty/i).count();
    expect(hasBottles + isEmpty).toBeGreaterThan(0);
  });

  test("Home never claims a wine is ready tonight", async ({ page }) => {
    await waitForHomeLoaded(page);
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).not.toContain("tonight");
    for (const banned of ["longevity", "legacy risk", "forecast", "we recommend"]) {
      expect(text, `Home shows Phase 8 language: ${banned}`).not.toContain(banned);
    }
  });

  test("a Home panel navigates into the Cellar with the ready filter", async ({ page }) => {
    await waitForHomeLoaded(page);

    // Seed rather than depending on whatever the cellar happens to hold, so
    // the panel is guaranteed present and this never skips.
    await seedReadyWine(page);
    await page.reload();
    await waitForHomeLoaded(page);

    const ready = page.getByText(/ready to drink/i);
    await expect(ready, "the seeded wine should produce a Ready panel").toHaveCount(1, {
      timeout: 20_000,
    });

    await ready.click();

    await expect(page).toHaveURL(/\/cellar/);
    await expect(page.getByRole("heading", { name: "Cellar" })).toBeVisible();

    // The filter must actually have arrived — the control reports its own
    // active count, which is the app's own signal rather than an inference.
    await expect(
      page.getByRole("button", { name: /Filters, 1 active/i }),
      "Cellar should open with the ready filter applied",
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Home does not scroll horizontally at 390px", async ({ page }) => {
    await waitForHomeLoaded(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
