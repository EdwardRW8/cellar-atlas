// @vitest-environment jsdom

/**
 * ATLAS RENDERING
 *
 * The behaviours that matter are the honest ones: neutral countries render
 * without collection data, shading comes only from canonical aggregation, and
 * the appellation view contains no map at all.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { WorldChoropleth, project } from "@/features/atlas/WorldChoropleth";
import { CountrySymbols } from "@/features/atlas/CountrySymbols";
import { AppellationList } from "@/features/atlas/AppellationList";
import { AtlasBoundary } from "@/features/atlas/AtlasBoundary";
import { buildAtlasData } from "@/domain/atlas-aggregation";
import type { CountryGeometry } from "@/data/geo/world-geometry";
import type { WineSummary, GeoPath } from "@/domain/types";

afterEach(cleanup);

function geo(country: [string, string] | null, region?: [string, string]): GeoPath {
  return {
    country: country ? { id: `c-${country[0]}`, name: country[1], code: country[0] } : null,
    region: region ? { id: `r-${region[0]}`, name: region[1] } : null,
    appellation: null,
    unmatched: null,
  };
}

function wine(geography: GeoPath, bottles = 3): WineSummary {
  return {
    wine: {
      id: Math.random().toString(36).slice(2),
      producer: "Test",
      name: "Test Wine",
      vintage: 2018,
      colour: "Red",
      grapes: [],
      geography,
      drinkFrom: 2020,
      drinkUntil: 2040,
      notes: null,
      version: 1,
    },
    activeBottles: bottles,
    totalBottles: bottles,
    locations: [],
    totalValue: 100,
    valuation: { valuedBottles: 0, activeBottles: 0 },
  };
}

/** Three countries of geometry; only some will have collection data. */
const GEOMETRY: CountryGeometry[] = [
  {
    iso: "FR",
    name: "France",
    polygons: [
      [
        [
          [0, 45],
          [5, 45],
          [5, 50],
          [0, 50],
          [0, 45],
        ],
      ],
    ],
  },
  {
    iso: "IT",
    name: "Italy",
    polygons: [
      [
        [
          [10, 40],
          [15, 40],
          [15, 45],
          [10, 45],
          [10, 40],
        ],
      ],
    ],
  },
  {
    iso: "MN",
    name: "Mongolia",
    polygons: [
      [
        [
          [100, 45],
          [110, 45],
          [110, 50],
          [100, 50],
          [100, 45],
        ],
      ],
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// WORLD — NEUTRAL CONTEXT VS COLLECTION DATA
// ═══════════════════════════════════════════════════════════════════════════

describe("the world map renders full geographic context", () => {
  const data = buildAtlasData([wine(geo(["FR", "France"]))], undefined, 2026);

  function renderWorld() {
    const onSelect = vi.fn();
    const r = render(
      <WorldChoropleth
        geometry={GEOMETRY}
        nodes={data.countries}
        metric="bottles"
        selectedCode={null}
        onSelectCountry={onSelect}
      />,
    );
    return { ...r, onSelect };
  }

  it("draws EVERY country, including those with no collection data", () => {
    const { container } = renderWorld();
    expect(container.querySelectorAll("path")).toHaveLength(3);
  });

  it("a country with no collection data renders NEUTRAL, not shaded", () => {
    const { container } = renderWorld();
    const paths = [...container.querySelectorAll("path")];
    const mongolia = paths[2]!;
    expect(mongolia.getAttribute("fill")).toBe("rgba(255,255,255,0.05)");
  });

  it("only a country with canonical data is shaded", () => {
    const { container } = renderWorld();
    const france = container.querySelectorAll("path")[0]!;
    expect(france.getAttribute("fill")).toMatch(/rgba\(217,174,85/);
  });

  it("a country with no data is NOT interactive", () => {
    const { container } = renderWorld();
    const mongolia = container.querySelectorAll("path")[2]!;
    expect(mongolia.getAttribute("role")).toBeNull();
    expect(mongolia.getAttribute("tabindex")).toBeNull();
  });

  it("a country with data IS interactive and labelled", () => {
    const { container } = renderWorld();
    const france = container.querySelectorAll("path")[0]!;
    expect(france.getAttribute("role")).toBe("button");
    expect(france.getAttribute("aria-label")).toMatch(/France: 3 bottles/);
  });

  it("tapping a country with data drills in", () => {
    const { container, onSelect } = renderWorld();
    fireEvent.click(container.querySelectorAll("path")[0]!);
    expect(onSelect).toHaveBeenCalledWith("FR");
  });

  it("tapping a neutral country does NOTHING", () => {
    const { container, onSelect } = renderWorld();
    fireEvent.click(container.querySelectorAll("path")[2]!);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("scales to its container so it cannot overflow horizontally", () => {
    const { container } = renderWorld();
    const svg = container.querySelector("svg")!;
    expect(svg.style.width).toBe("100%");
    expect(svg.getAttribute("width")).toBeNull();
    expect(svg.getAttribute("viewBox")).toBeTruthy();
  });
});

describe("projection", () => {
  it("maps longitude to x and inverts latitude for screen space", () => {
    expect(project(0, 0)).toEqual({ x: 0, y: -0 });
    expect(project(10, 50)).toEqual({ x: 10, y: -50 });
    // North is up: a higher latitude has a smaller y.
    expect(project(0, 60).y).toBeLessThan(project(0, 40).y);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COUNTRY — PROPORTIONAL SYMBOLS AT VERIFIED CENTROIDS
// ═══════════════════════════════════════════════════════════════════════════

describe("the country view uses verified centroids, not shapes", () => {
  const centroids = new Map([
    ["r-bdx", { latitude: 44.84, longitude: -0.58, precision: "approximate" }],
    ["r-bur", { latitude: 47.05, longitude: 4.85, precision: "approximate" }],
  ]);
  const data = buildAtlasData(
    [
      wine(geo(["FR", "France"], ["bdx", "Bordeaux"]), 10),
      wine(geo(["FR", "France"], ["bur", "Burgundy"]), 2),
    ],
    centroids,
    2026,
  );
  const regions = data.regionsByCountry.FR!;

  function renderCountry() {
    const onSelect = vi.fn();
    const r = render(
      <CountrySymbols
        countryGeometry={GEOMETRY[0]!}
        countryName="France"
        regions={regions}
        metric="bottles"
        selectedRegionId={null}
        onSelectRegion={onSelect}
      />,
    );
    return { ...r, onSelect };
  }

  it("draws a CIRCLE per region — a point, not a territory", () => {
    const { container } = renderCountry();
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });

  it("draws exactly ONE path — the country outline, no region shapes", () => {
    const { container } = renderCountry();
    expect(container.querySelectorAll("path")).toHaveLength(1);
  });

  it("sizes circles by the metric", () => {
    const { container } = renderCountry();
    const radii = [...container.querySelectorAll("circle")].map((c) =>
      Number(c.getAttribute("r")),
    );
    expect(radii[0]).toBeGreaterThan(radii[1]!);
  });

  it("states plainly that circles are locations, not boundaries", () => {
    renderCountry();
    expect(screen.getByText(/locations, not territory boundaries/i)).toBeTruthy();
  });

  it("selecting a region drills in", () => {
    const { container, onSelect } = renderCountry();
    fireEvent.click(container.querySelector("g")!);
    expect(onSelect).toHaveBeenCalled();
  });

  it("a region WITHOUT a centroid is not placed, and is reported", () => {
    const noCoords = buildAtlasData(
      [wine(geo(["FR", "France"], ["unknown", "Unplaced"]))],
      new Map(),
      2026,
    ).regionsByCountry.FR!;

    const { container } = render(
      <CountrySymbols
        countryGeometry={GEOMETRY[0]!}
        countryName="France"
        regions={noCoords}
        metric="bottles"
        selectedRegionId={null}
        onSelectRegion={vi.fn()}
      />,
    );
    expect(container.querySelectorAll("circle")).toHaveLength(0);
    expect(screen.getByText(/could not be placed/i)).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// APPELLATION — EXPLICITLY NO MAP
// ═══════════════════════════════════════════════════════════════════════════

describe("the appellation view contains NO map", () => {
  const appellations = buildAtlasData(
    [
      {
        ...wine(geo(["FR", "France"], ["bdx", "Bordeaux"]), 6),
        wine: {
          ...wine(geo(["FR", "France"], ["bdx", "Bordeaux"])).wine,
          geography: {
            country: { id: "c-FR", name: "France", code: "FR" },
            region: { id: "r-bdx", name: "Bordeaux" },
            appellation: { id: "a-pau", name: "Pauillac" },
            unmatched: null,
          },
        },
      },
    ],
    undefined,
    2026,
  ).appellationsByRegion["r-bdx"]!;

  function renderAppellations() {
    return render(
      <AppellationList
        appellations={appellations}
        regionName="Bordeaux"
        metric="bottles"
      />,
    );
  }

  it("renders NO svg", () => {
    const { container } = renderAppellations();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders NO path, circle or polygon", () => {
    const { container } = renderAppellations();
    expect(container.querySelector("path")).toBeNull();
    expect(container.querySelector("circle")).toBeNull();
    expect(container.querySelector("polygon")).toBeNull();
  });

  it("explains WHY there is no map", () => {
    renderAppellations();
    expect(screen.getByText(/no reliable open boundary data exists/i)).toBeTruthy();
  });

  it("ranks appellations with comparison bars", () => {
    renderAppellations();
    expect(screen.getByText("Pauillac")).toBeTruthy();
    expect(screen.getByText(/6 bottles/)).toBeTruthy();
  });

  it("handles a region with no appellations", () => {
    render(<AppellationList appellations={[]} regionName="Bordeaux" metric="bottles" />);
    expect(screen.getByText(/no appellations recorded/i)).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INNER BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════

describe("the Atlas boundary degrades rather than blanking", () => {
  function Boom(): JSX.Element {
    throw new Error("map exploded");
  }

  it("falls back to the list when the map throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AtlasBoundary fallback={<p>Country list</p>}>
        <Boom />
      </AtlasBoundary>,
    );
    expect(screen.getByText("Country list")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/could not be drawn/i);
    spy.mockRestore();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <AtlasBoundary fallback={<p>Country list</p>}>
        <p>The map</p>
      </AtlasBoundary>,
    );
    expect(screen.getByText("The map")).toBeTruthy();
    expect(screen.queryByText("Country list")).toBeNull();
  });
});
