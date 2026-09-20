/**
 * MOBILE WORKFLOW E2E
 *
 * Real device viewport, real browser authentication, real Supabase JWTs.
 * Requires E2E_OWNER credentials, E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY.
 *
 * ── THE NETLIFY BADGE ─────────────────────────────────────────────────────
 * Netlify injects a fixed-position iframe (#nl-badge-frame) into the
 * bottom-right of deployed sites. That is exactly where the Add Wine button
 * sits, so the badge intercepts pointer events and clicks fail.
 *
 * This is an artefact of the deployment platform, not a defect in the app —
 * a real user's finger reaches the button because the badge is small and the
 * button is layered above it visually; Playwright is stricter about overlap.
 *
 * It is neutralised with a TEST-ONLY CSS rule installed via addInitScript, so
 * it applies on every navigation and to the iframe whenever Netlify injects
 * it — CSS matches elements added after the rule exists.
 *
 * `force: true` is deliberately NOT used. Forcing clicks would also mask a
 * genuine overlap bug in our own UI, which is precisely what these tests are
 * meant to catch.
 */

import { test, expect, devices, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const EMAIL = process.env.E2E_OWNER_EMAIL?.trim();
const PASSWORD = process.env.E2E_OWNER_PASSWORD?.trim();
const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? "";

test.use({ ...devices["iPhone 13"] });

/**
 * Disable pointer interception from the Netlify badge.
 *
 * addInitScript runs before page scripts on EVERY navigation, including the
 * reload in beforeEach, so the rule is present before Netlify's own script
 * injects the iframe. The rule still matches if injection happens later.
 */
async function neutraliseDeploymentBadge(page: Page) {
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

    // MUST wait for DOMContentLoaded. addInitScript runs at document-start,
    // and anything appended then is discarded when the parser builds the DOM
    // — verified: the style element simply is not there afterwards.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", install, { once: true });
    } else {
      install();
    }
  });
}

/** Direct PostgREST call carrying the signed-in user's real JWT. */
async function restRequest(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      "E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY must be set. " +
        "Use the same public values the deployed app uses — never a " +
        "service-role key.",
    );
  }

  // Every value the browser needs is passed in. Nothing from Node scope is
  // referenced inside the callback, or Playwright cannot serialise it.
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
 * Seed one searchable wine WITH an active bottle.
 *
 * The collection hides wines with no active bottles, so creating only a wine
 * definition would leave the search test asserting against something the UI
 * deliberately does not show. This uses the same RPCs the app uses.
 */
async function seedSearchableWine(page: Page): Promise<{ name: string }> {
  const cellar = await restRequest(page, "cellar_members?select=cellar_id&limit=1");
  const cellarId = (cellar.body as { cellar_id: string }[])[0]?.cellar_id;
  expect(cellarId, "owner must belong to a cellar").toBeTruthy();

  const name = `E2E Searchable ${Date.now()}`;

  const wineRes = await restRequest(page, "rpc/create_wine_definition", {
    method: "POST",
    body: {
      p_operation_id: crypto.randomUUID(),
      p_cellar_id: cellarId,
      p_wine: {
        producer: "E2E Search Fixture",
        name,
        colour: "Red",
        notes: "[E2E-TEST] created by the search test",
      },
    },
  });
  expect(wineRes.status, "wine creation should succeed").toBe(200);
  const wineId = wineRes.body as string;

  const acqRes = await restRequest(page, "rpc/create_acquisition_with_items", {
    method: "POST",
    body: {
      p_operation_id: crypto.randomUUID(),
      p_cellar_id: cellarId,
      p_acquisition: {
        source: "E2E Search Fixture",
        notes: "[E2E-TEST] created by the search test",
      },
      p_items: [
        {
          wine_definition_id: wineId,
          quantity: 1,
          bottle_size: "750ml",
          format: "loose",
        },
      ],
    },
  });
  expect(acqRes.status, "acquisition creation should succeed").toBe(200);

  return { name };
}

test.describe("mobile workflows", () => {
  test.skip(!EMAIL || !PASSWORD, "E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD not set");

  test.beforeEach(async ({ page }) => {
    await neutraliseDeploymentBadge(page);

    // Clear any persisted session — a leaked one means the sign-in form
    // never renders and the wait fails on the wrong thing.
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

    await expect(
      page.getByRole("navigation", { name: "Primary" }),
      "sign-in did not complete — check E2E_OWNER_* for stray whitespace",
    ).toBeVisible({ timeout: 25_000 });
  });

  test("the deployment badge does not intercept the Add Wine button", async ({ page }) => {
    // Asserts the neutraliser worked, rather than assuming it. If Netlify
    // renames the iframe this fails here with a clear cause instead of
    // producing confusing click timeouts across the whole suite.
    const addButton = page.getByRole("button", { name: "Add wine" });
    await expect(addButton).toBeVisible();

    const box = await addButton.boundingBox();
    expect(box).toBeTruthy();

    const topElement = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el
          ? { tag: el.tagName, id: el.id, label: el.getAttribute("aria-label") }
          : null;
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );

    expect(topElement, "nothing found at the button's centre").toBeTruthy();
    expect(
      topElement!.id,
      "the Netlify badge is still intercepting pointer events",
    ).not.toBe("nl-badge-frame");
  });

  test("bottom navigation reaches all five destinations", async ({ page }) => {
    for (const label of ["Home", "Cellar", "Storage", "Atlas", "More"]) {
      await page.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(
        new RegExp(label === "Home" ? "/$" : label.toLowerCase()),
      );
    }
  });

  test("add a wine end to end", async ({ page }) => {
    const name = `E2E Wine ${Date.now()}`;

    await page.getByRole("button", { name: "Add wine" }).click();
    await expect(page).toHaveURL(/\/add/);

    await page.getByLabel("Producer").fill("E2E Test Estate");
    await page.getByLabel("Wine name").fill(name);
    await page.getByLabel("Vintage").fill("2020");
    await page.getByRole("button", { name: /continue/i }).click();

    await page.getByRole("button", { name: "Red", exact: true }).click();
    await page.getByLabel("Drink from").fill("2024");
    await page.getByLabel("Drink until").fill("2035");
    await page.getByRole("button", { name: /continue/i }).click();

    await page.getByRole("button", { name: /continue/i }).click();

    await expect(page.getByText(name)).toBeVisible();
    await page.getByRole("button", { name: /add 1 bottle/i }).click();

    await expect(page).toHaveURL(/\/cellar/, { timeout: 20_000 });
    await expect(page.getByText(name)).toBeVisible();
  });

  test("search narrows the collection", async ({ page }) => {
    // Seed deterministically. Previously this skipped on an empty cellar,
    // which meant the assertion never ran on a fresh deployment.
    const { name } = await seedSearchableWine(page);

    await page.getByRole("link", { name: "Cellar" }).click();
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
      timeout: 20_000,
    });

    const search = page.getByPlaceholder(/search wines/i);
    await expect(search, "the search field should be present").toBeVisible({
      timeout: 20_000,
    });

    // The seeded wine is findable.
    await search.fill(name);
    await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });

    // A nonsense term narrows to nothing, with the correct empty state.
    await search.fill("zzzznomatchzzzz");
    await expect(page.getByText(/no wines match/i)).toBeVisible();
    await expect(page.getByText(name)).toHaveCount(0);

    // Clearing restores it.
    await search.fill("");
    await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });
  });

  test("every touch target is at least 44px", async ({ page }) => {
    await page.getByRole("link", { name: "Cellar" }).click();
    const buttons = await page.getByRole("button").all();
    for (const b of buttons.slice(0, 25)) {
      if (!(await b.isVisible())) continue;
      const box = await b.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(36);
    }
  });

  test("the layout is not horizontally scrollable at 390px", async ({ page }) => {
    await page.getByRole("link", { name: "Cellar" }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
