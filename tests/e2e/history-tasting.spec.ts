/**
 * HISTORY & TASTING — LIVE ACCEPTANCE
 *
 * Additive. Every existing Phase 3–8 assertion is untouched.
 *
 * Navigation follows the real hierarchy: More → History, More → Tastings.
 * Loading states are awaited explicitly; no timeout-then-catch branching.
 */

import { test, expect, devices, type Page } from "@playwright/test";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const EMAIL = process.env.E2E_OWNER_EMAIL?.trim();
const PASSWORD = process.env.E2E_OWNER_PASSWORD?.trim();

test.use({ ...devices["iPhone 13"] });

async function waitForLoaded(page: Page, heading: string) {
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.getByRole("status", { name: /loading/i })).toHaveCount(0, {
    timeout: 25_000,
  });
}

async function openFromMore(page: Page, label: RegExp, heading: string) {
  await page.getByRole("link", { name: "More" }).click();
  await expect(page.getByRole("heading", { name: "More" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: label }).click();
  await waitForLoaded(page, heading);
}

test.describe("history and tastings", () => {
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

  test("History is reachable and shows real activity", async ({ page }) => {
    await openFromMore(page, /History/, "History");
    await expect(page).toHaveURL(/\/history/);

    // Either real events or the designed empty state — never a placeholder.
    const hasEvents = await page
      .getByRole("button", { name: /Added|Moved|Consumed/ })
      .count();
    const isEmpty = await page.getByText(/no history yet/i).count();
    expect(hasEvents + isEmpty).toBeGreaterThan(0);
  });

  test("History offers NO way to change anything", async ({ page }) => {
    await openFromMore(page, /History/, "History");

    for (const name of [/^edit$/i, /^delete$/i, /^remove$/i, /^save/i]) {
      await expect(
        page.getByRole("button", { name }),
        `History offers a ${name} control`,
      ).toHaveCount(0);
    }
  });

  test("History shows plain English, never raw event types", async ({ page }) => {
    await openFromMore(page, /History/, "History");
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).not.toContain("tasting_recorded");
    expect(text).not.toContain("event_type");
  });

  test("Tastings is reachable", async ({ page }) => {
    await openFromMore(page, /Tastings/, "Tastings");
    await expect(page).toHaveURL(/\/tastings/);
  });

  test("neither screen scrolls horizontally at 390px", async ({ page }) => {
    for (const [label, heading] of [
      [/History/, "History"],
      [/Tastings/, "Tastings"],
    ] as const) {
      await openFromMore(page, label, heading);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${heading} overflows`).toBeLessThanOrEqual(1);
    }
  });

  test("More no longer claims Pairings is coming", async ({ page }) => {
    await page.getByRole("link", { name: "More" }).click();
    await expect(page.getByRole("heading", { name: "More" })).toBeVisible({
      timeout: 20_000,
    });
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).not.toContain("pairings");
  });
});
