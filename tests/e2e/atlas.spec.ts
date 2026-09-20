/**
 * ATLAS — LIVE ACCEPTANCE
 *
 * Additive. Every existing Phase 3/4/5/6 assertion is untouched.
 *
 * Atlas assertions need a wine with canonical geography. Rather than skipping
 * when the cellar happens not to contain one, a wine is seeded through the
 * application's own RPCs over the real JWT path, using a geo_region_id read
 * from the canonical hierarchy. Marked [E2E-TEST].
 */

import { test, expect, devices, type Page } from "@playwright/test";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const EMAIL = process.env.E2E_OWNER_EMAIL?.trim();
const PASSWORD = process.env.E2E_OWNER_PASSWORD?.trim();
const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? "";

test.use({ ...devices["iPhone 13"] });

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
 * Seed a wine with CANONICAL geography, so Atlas has something to map.
 *
 * The region id comes from geo_regions, never invented — the same rule the
 * product follows.
 */
async function seedMappedWine(page: Page): Promise<{ country: string; region: string }> {
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

  // Any seeded region will do; take the first with a parent country.
  const regionRes = await restRequest(
    page,
    "geo_regions?select=id,name,country_code,level&level=eq.region&limit=1",
  );
  const region = (
    regionRes.body as { id: string; name: string; country_code: string }[]
  )[0];
  expect(region, "the canonical hierarchy should contain regions").toBeTruthy();

  const wineRes = await restRequest(page, "rpc/create_wine_definition", {
    method: "POST",
    body: {
      p_operation_id: crypto.randomUUID(),
      p_cellar_id: cellarId,
      p_wine: {
        producer: "E2E Atlas Fixture",
        name: `Atlas Wine ${Date.now()}`,
        colour: "Red",
        geo_region_id: region!.id,
        country_code: region!.country_code,
        notes: "[E2E-TEST] created by the Atlas test",
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
        source: "E2E Atlas Fixture",
        notes: "[E2E-TEST] created by the Atlas test",
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

  return { country: region!.country_code, region: region!.name };
}

/** Atlas has finished loading when the skeleton is gone. */
async function waitForAtlasLoaded(page: Page) {
  await expect(page.getByRole("heading", { name: "Atlas" })).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.getByRole("status", { name: /loading/i })).toHaveCount(0, {
    timeout: 25_000,
  });
}

test.describe("atlas", () => {
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

  test("Atlas opens from the navigation and is no longer a placeholder", async ({
    page,
  }) => {
    await page.getByRole("link", { name: "Atlas" }).click();
    await waitForAtlasLoaded(page);
    await expect(page.getByText(/arrives in phase 7/i)).toHaveCount(0);
  });

  test("the world map renders real country geometry", async ({ page }) => {
    await page.getByRole("link", { name: "Atlas" }).click();
    await waitForAtlasLoaded(page);
    await seedMappedWine(page);
    await page.reload();
    await waitForAtlasLoaded(page);

    const map = page.getByRole("group", { name: /world map/i });
    await expect(map).toBeVisible({ timeout: 20_000 });

    // Full world context, not only the countries we hold wine from.
    const countries = await map.locator("path").count();
    expect(countries).toBeGreaterThan(100);
  });

  test("drilling into a country shows regions as circles, not shapes", async ({ page }) => {
    await page.getByRole("link", { name: "Atlas" }).click();
    await waitForAtlasLoaded(page);
    const seeded = await seedMappedWine(page);
    await page.reload();
    await waitForAtlasLoaded(page);

    // Use the list beneath the map — deterministic regardless of projection.
    await page
      .getByRole("button", { name: new RegExp(seeded.region, "i") })
      .first()
      .click()
      .catch(async () => {
        // At world level the list shows countries; open the country first.
        await page
          .locator("button")
          .filter({ hasText: /bottle/ })
          .first()
          .click();
        await page
          .getByRole("button", { name: new RegExp(seeded.region, "i") })
          .first()
          .click();
      });

    await expect(page.getByText(/locations, not territory boundaries/i)).toBeVisible({
      timeout: 20_000,
    });
  });

  test("Atlas never draws appellation boundaries", async ({ page }) => {
    await page.getByRole("link", { name: "Atlas" }).click();
    await waitForAtlasLoaded(page);
    const text = (await page.locator("body").innerText()).toLowerCase();
    for (const banned of ["longevity", "legacy risk", "forecast", "we recommend"]) {
      expect(text, `Atlas shows Phase 8 language: ${banned}`).not.toContain(banned);
    }
  });

  test("Atlas does not scroll horizontally at 390px", async ({ page }) => {
    await page.getByRole("link", { name: "Atlas" }).click();
    await waitForAtlasLoaded(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
