// @vitest-environment jsdom

/**
 * EDIT WINE + MANDATORY TYPE (UI)
 *
 * The database enforcement is proved in mandatory-wine-type.test.ts. These
 * cover the form: preloading, validation, and that a type cannot be cleared.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EditWineForm, validateEdit } from "@/features/cellar/EditWineForm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DomainWine, WineColour } from "@/domain/types";

/**
 * A STABLE mock object.
 *
 * Returning a fresh object from useCellar() on every call gives `repository`
 * a new identity each render, so any effect keyed on it re-fires forever —
 * which exhausted the heap before a single test ran.
 */
const stubRepository = { searchGeography: vi.fn().mockResolvedValue([]) };
const stubCellar = { repository: stubRepository };
vi.mock("@/hooks/useCellar", () => ({ useCellar: () => stubCellar }));

afterEach(cleanup);

function wine(over: Partial<DomainWine> = {}): DomainWine {
  return {
    id: "w1",
    producer: "Château Test",
    name: "Grand Vin",
    vintage: 2018,
    colour: "Red",
    grapes: ["Merlot"],
    geography: {
      country: { id: "c-FR", name: "France", code: "FR" },
      region: { id: "r-bdx", name: "Bordeaux" },
      appellation: null,
      unmatched: null,
    },
    drinkFrom: 2025,
    drinkUntil: 2040,
    notes: "A note",
    version: 3,
    ...over,
  };
}

function renderForm(w: DomainWine = wine()) {
  const onSave = vi.fn().mockResolvedValue({ ok: true });
  const onCancel = vi.fn();
  const r = render(
    <MemoryRouter>
      <EditWineForm wine={w} onCancel={onCancel} onSave={onSave} />
    </MemoryRouter>,
  );
  return { ...r, onSave, onCancel };
}

const saveButton = () =>
  screen.getByRole("button", { name: /save changes/i }) as HTMLButtonElement;

describe("existing values preload", () => {
  it("preloads producer, name and vintage", () => {
    renderForm();
    expect(screen.getByDisplayValue("Château Test")).toBeTruthy();
    expect(screen.getByDisplayValue("Grand Vin")).toBeTruthy();
    expect(screen.getByDisplayValue("2018")).toBeTruthy();
  });

  it("preloads the current type as selected", () => {
    renderForm();
    expect(screen.getByRole("radio", { name: "Red" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("preloads grapes", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /remove merlot/i })).toBeTruthy();
  });

  it("preloads the drinking window", () => {
    renderForm();
    expect(screen.getByDisplayValue("2025")).toBeTruthy();
    expect(screen.getByDisplayValue("2040")).toBeTruthy();
  });

  it("preloads notes", () => {
    renderForm();
    expect(screen.getByDisplayValue("A note")).toBeTruthy();
  });

  it("handles a non-vintage wine without inventing a year", () => {
    renderForm(wine({ vintage: null }));
    const field = screen.getByLabelText(/vintage/i) as HTMLInputElement;
    expect(field.value).toBe("");
  });
});

describe("fields can be corrected", () => {
  it("saves an edited producer, name and vintage", async () => {
    const { onSave } = renderForm();
    fireEvent.change(screen.getByDisplayValue("Château Test"), {
      target: { value: "Corrected Estate" },
    });
    fireEvent.change(screen.getByDisplayValue("Grand Vin"), {
      target: { value: "Second Wine" },
    });
    fireEvent.change(screen.getByDisplayValue("2018"), { target: { value: "2019" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      producer: "Corrected Estate",
      name: "Second Wine",
      vintage: 2019,
    });
  });

  it("saves an edited type", async () => {
    const { onSave } = renderForm();
    fireEvent.click(screen.getByRole("radio", { name: "White" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].colour).toBe("White");
  });

  it("saves an edited drinking window", async () => {
    const { onSave } = renderForm();
    fireEvent.change(screen.getByDisplayValue("2025"), { target: { value: "2028" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].drink_from).toBe(2028);
  });

  it("saves edited grapes", async () => {
    const { onSave } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /remove merlot/i }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].grapes).toEqual([]);
  });

  it("sends canonical geography ids, never invented text", async () => {
    const { onSave } = renderForm();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patch = onSave.mock.calls[0]![0];
    expect(patch.geo_region_id).toBe("r-bdx");
    expect(patch.country_code).toBe("FR");
    expect(patch.region_text).toBeNull();
  });
});

describe("wine type cannot be cleared", () => {
  it("tapping the SELECTED type does not deselect it", async () => {
    const { onSave } = renderForm();
    fireEvent.click(screen.getByRole("radio", { name: "Red" }));
    expect(screen.getByRole("radio", { name: "Red" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].colour).toBe("Red");
  });

  it("a legacy typeless wine CANNOT be saved until a type is chosen", () => {
    renderForm(wine({ colour: null }));
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/choose one to save/i)).toBeTruthy();
  });

  it("choosing a type unblocks a legacy wine", async () => {
    const { onSave } = renderForm(wine({ colour: null }));
    fireEvent.click(screen.getByRole("radio", { name: "Sparkling" }));
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].colour).toBe("Sparkling");
  });

  it("never sends a null type", async () => {
    const { onSave } = renderForm();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].colour).not.toBeNull();
  });
});

describe("validation", () => {
  it("rejects an empty producer or name", () => {
    expect(
      validateEdit({
        producer: "",
        name: "X",
        colour: "Red",
        drinkFrom: null,
        drinkUntil: null,
      }),
    ).toMatch(/producer/i);
    expect(
      validateEdit({
        producer: "X",
        name: " ",
        colour: "Red",
        drinkFrom: null,
        drinkUntil: null,
      }),
    ).toMatch(/name/i);
  });

  it("rejects a missing type", () => {
    expect(
      validateEdit({
        producer: "X",
        name: "Y",
        colour: null,
        drinkFrom: null,
        drinkUntil: null,
      }),
    ).toMatch(/wine type/i);
  });

  it("REJECTS a window that closes before it opens", () => {
    expect(
      validateEdit({
        producer: "X",
        name: "Y",
        colour: "Red" as WineColour,
        drinkFrom: 2040,
        drinkUntil: 2025,
      }),
    ).toMatch(/cannot close before/i);
  });

  it("accepts equal years", () => {
    expect(
      validateEdit({
        producer: "X",
        name: "Y",
        colour: "Red" as WineColour,
        drinkFrom: 2030,
        drinkUntil: 2030,
      }),
    ).toBeNull();
  });

  it("accepts an open-ended window", () => {
    expect(
      validateEdit({
        producer: "X",
        name: "Y",
        colour: "Red" as WineColour,
        drinkFrom: 2030,
        drinkUntil: null,
      }),
    ).toBeNull();
  });

  it("blocks Save and shows the reason when the window is invalid", () => {
    renderForm();
    fireEvent.change(screen.getByDisplayValue("2040"), { target: { value: "2000" } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/cannot close before it opens/i)).toBeTruthy();
  });

  it("surfaces a save failure rather than pretending it worked", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: false, error: "version conflict" });
    render(
      <MemoryRouter>
        <EditWineForm wine={wine()} onCancel={vi.fn()} onSave={onSave} />
      </MemoryRouter>,
    );
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/version conflict/);
  });
});

describe("architecture", () => {
  const FORM = readFileSync(
    join(process.cwd(), "src/features/cellar/EditWineForm.tsx"),
    "utf8",
  );
  const DETAIL = readFileSync(
    join(process.cwd(), "src/features/cellar/WineDetailScreen.tsx"),
    "utf8",
  );
  const ADD = readFileSync(
    join(process.cwd(), "src/features/add-wine/AddWineScreen.tsx"),
    "utf8",
  );

  it("Edit Wine is reachable from Wine detail", () => {
    expect(DETAIL).toMatch(/Edit wine/);
    expect(DETAIL).toMatch(/<EditWineForm/);
  });

  it("saving goes through the established RPC path with the expected version", () => {
    expect(DETAIL).toMatch(/m\.updateWine\(/);
    expect(DETAIL).toMatch(/version: wine\.version/);
  });

  it("NO direct table update bypasses the mutation architecture", () => {
    for (const src of [FORM, DETAIL]) {
      expect(src).not.toMatch(/\.from\(|getSupabase|\.update\(\{/);
    }
  });

  it("reuses the canonical GeographyPicker rather than duplicating it", () => {
    expect(FORM).toMatch(
      /import \{ GeographyPicker.*from "@\/features\/add-wine\/GeographyPicker"/,
    );
    expect(FORM).not.toMatch(/geo_regions|searchGeography/);
  });

  it("reuses the existing wine-type taxonomy, inventing none", () => {
    expect(FORM).toMatch(
      /"Red",\s*"White",\s*"Rosé",\s*"Sparkling",\s*"Dessert",\s*"Fortified"/,
    );
    expect(FORM).not.toMatch(/"Orange"|"Amber"|"Natural"/);
  });

  it("Add Wine requires a type before the wizard can complete", () => {
    // NOT on the step-0 gate: the type control lives on the Details step, and
    // requiring it earlier deadlocked the wizard. The requirement belongs in
    // validateIdentity, which gates that step.
    const draftSrc = readFileSync(join(process.cwd(), "src/domain/wine-draft.ts"), "utf8");
    expect(draftSrc).toMatch(/if \(!colour\) errors\.colour = "Wine type is required"/);
    expect(ADD).toMatch(/identityCheck\.valid/);
  });

  it("Add Wine no longer allows deselecting the type", () => {
    expect(ADD).toMatch(/onClick=\{\(\) => set\("colour", c\)\}/);
    expect(ADD).not.toMatch(/draft\.identity\.colour === c \? null : c/);
  });

  it("the form writes no bottle, acquisition or event data", () => {
    // Strip comments: the header legitimately EXPLAINS that bottles and
    // history are untouched, and matching prose would flag the explanation.
    const executable = FORM.split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(executable).not.toMatch(/bottle_|acquisition|bottle_events/i);
    expect(executable).not.toMatch(/updateBottle|moveBottle|changeBottleStatus/);
  });
});

describe("mobile safety", () => {
  it("controls meet the touch target", () => {
    renderForm();
    for (const b of screen.getAllByRole("button")) {
      const min = Number.parseInt((b as HTMLElement).style.minHeight, 10);
      if (!Number.isNaN(min)) expect(min).toBeGreaterThanOrEqual(36);
    }
  });

  it("cancel does not save", () => {
    const { onCancel, onSave } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
