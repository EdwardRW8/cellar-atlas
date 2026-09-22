// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  isBottleSize,
  bottleSizeFromMl,
  parseMillilitres,
  COMMON_BOTTLE_SIZES,
  DEFAULT_BOTTLE_SIZE,
  MAX_BOTTLE_ML,
} from "@/domain/bottle-size";
import { bottleSizeSchema } from "@/data/schemas";
import { mapBottleSize } from "@/domain/csv-import/mappings";
import { emptyDraft, validatePlacement } from "@/domain/wine-draft";
import { readFileSync } from "node:fs";

vi.mock("@/hooks/useCellar", () => ({ useCellar: () => ({}) }));
const { BottleSizePicker } = await import("@/features/add-wine/AddWineScreen");

afterEach(cleanup);

const VALID = [
  "200ml",
  "250ml",
  "375ml",
  "500ml",
  "750ml",
  "1000ml",
  "1500ml",
  "3000ml",
  "6000ml",
  "30000ml",
];
const INVALID = [
  "0ml",
  "-200ml",
  "abc",
  "750",
  "750 ml",
  "",
  "0750ml",
  "750ML",
  "7.5ml",
  "75cl",
  "60000ml",
  " 750ml",
];

describe("the domain: any canonical volume, not a list", () => {
  it("accepts legitimate uncommon and common sizes", () => {
    for (const s of VALID) expect(isBottleSize(s), s).toBe(true);
  });
  it("rejects malformed sizes", () => {
    for (const s of INVALID) expect(isBottleSize(s), JSON.stringify(s)).toBe(false);
  });
  it("the bound is generous: 30 litres fits, an extra zero on 6 litres does not", () => {
    expect(bottleSizeFromMl(30_000)).toBe("30000ml");
    expect(bottleSizeFromMl(MAX_BOTTLE_ML + 1)).toBeNull();
  });
  it("never rounds", () => {
    expect(bottleSizeFromMl(750.5)).toBeNull();
    expect(parseMillilitres("750.5")).toBeNull();
  });
  it("common sizes are shortcuts, and include 200ml", () => {
    expect(COMMON_BOTTLE_SIZES).toContain("200ml");
    for (const s of ["375ml", "750ml", "1500ml", "3000ml", "6000ml"])
      expect(COMMON_BOTTLE_SIZES).toContain(s);
    expect(COMMON_BOTTLE_SIZES.every(isBottleSize)).toBe(true);
  });
  it("the default is unchanged", () => {
    expect(DEFAULT_BOTTLE_SIZE).toBe("750ml");
  });
});

describe("the Zod schema validates the format, not a whitelist", () => {
  it("accepts legitimate uncommon sizes", () => {
    for (const s of VALID) expect(bottleSizeSchema.safeParse(s).success, s).toBe(true);
  });
  it("rejects malformed sizes", () => {
    for (const s of INVALID)
      expect(bottleSizeSchema.safeParse(s).success, JSON.stringify(s)).toBe(false);
  });
});

describe("CSV import: generic volumes, same tolerance, same default", () => {
  it.each([
    ["200", "200ml"],
    ["200ml", "200ml"],
    ["500", "500ml"],
    ["500ml", "500ml"],
    ["750", "750ml"],
    ["750ml", "750ml"],
    ["1000", "1000ml"],
  ])("%s → %s", (input, out) => {
    expect(mapBottleSize(input).value).toBe(out);
  });
  it("existing tolerance is kept: surrounding space, a spaced or capitalised ml", () => {
    expect(mapBottleSize("  750  ").value).toBe("750ml");
    expect(mapBottleSize("750 ml").value).toBe("750ml");
    expect(mapBottleSize("750ML").value).toBe("750ml");
  });
  it("blank still defaults to 750ml", () => {
    expect(mapBottleSize("").value).toBe("750ml");
  });
  it.each(["0", "-200", "abc", "7.5", "75cl", "1.5l", "60000"])(
    "explicit %s BLOCKS, never defaults",
    (bad) => {
      const m = mapBottleSize(bad);
      expect(m.value).toBeNull();
      expect(m.value === null && m.rejected.reason).toContain(`"${bad}"`);
    },
  );
  it("no unit other than ml is interpreted", () => {
    expect(mapBottleSize("75cl").value).toBeNull();
    expect(mapBottleSize("0.75").value).toBeNull();
  });
});

describe("Add Wine refuses an unfinished custom size before submission", () => {
  it("a custom valid size passes placement validation", () => {
    expect(
      validatePlacement({ ...emptyDraft(), bottleSize: "500ml" }, null).errors.bottleSize,
    ).toBeUndefined();
  });
  it("an empty or malformed size fails it", () => {
    expect(
      validatePlacement({ ...emptyDraft(), bottleSize: "" }, null).errors.bottleSize,
    ).toBeTruthy();
    expect(
      validatePlacement({ ...emptyDraft(), bottleSize: "abc" }, null).errors.bottleSize,
    ).toBeTruthy();
  });
});

describe("the Add Wine size picker", () => {
  const renderPicker = (value = "750ml") => {
    const onChange = vi.fn();
    render(<BottleSizePicker value={value} onChange={onChange} />);
    return onChange;
  };

  it("offers the common sizes, including 200ml, and Other…", () => {
    renderPicker();
    for (const s of ["200ml", "375ml", "750ml", "1500ml", "3000ml", "6000ml"]) {
      expect(screen.getByRole("radio", { name: s })).toBeTruthy();
    }
    expect(screen.getByRole("radio", { name: "Other…" })).toBeTruthy();
  });

  it("the Volume (ml) field is hidden until Other is chosen", () => {
    renderPicker();
    expect(screen.queryByLabelText("Volume (ml)")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Other…" }));
    expect(screen.getByLabelText("Volume (ml)")).toBeTruthy();
  });

  it("typing 500 stores the canonical 500ml — no 'ml' needed", () => {
    const onChange = renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: "Other…" }));
    fireEvent.change(screen.getByLabelText("Volume (ml)"), { target: { value: "500" } });
    expect(onChange).toHaveBeenLastCalledWith("500ml");
  });

  it("an invalid volume is shown as an error and stores no size", () => {
    const onChange = renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: "Other…" }));
    fireEvent.change(screen.getByLabelText("Volume (ml)"), { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(screen.getByRole("alert").textContent).toMatch(/whole number of millilitres/);
  });

  it("choosing a common size returns to it", () => {
    const onChange = renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: "200ml" }));
    expect(onChange).toHaveBeenLastCalledWith("200ml");
  });

  it("an existing uncommon size opens in Other with its volume", () => {
    renderPicker("500ml");
    expect(screen.getByRole("radio", { name: "Other…" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect((screen.getByLabelText("Volume (ml)") as HTMLInputElement).value).toBe("500");
  });

  it("the volume field meets the 44px touch target", () => {
    renderPicker("500ml");
    expect((screen.getByLabelText("Volume (ml)") as HTMLElement).style.minHeight).toBe(
      "44px",
    );
  });
});

describe("no finite whitelist survives anywhere", () => {
  it.each([
    "src/domain/types/index.ts",
    "src/data/schemas/index.ts",
    "src/features/add-wine/AddWineScreen.tsx",
    "src/domain/csv-import/mappings.ts",
  ])("%s holds no closed size list", (f) => {
    const s = readFileSync(f, "utf8");
    expect(s).not.toMatch(/"375ml"\s*\|\s*"750ml"/);
    expect(s).not.toMatch(/z\.enum\(\["375ml"/);
    expect(s).not.toMatch(/const SIZES = \[/);
    expect(s).not.toMatch(/CANONICAL_BOTTLE_SIZES/);
  });
});
