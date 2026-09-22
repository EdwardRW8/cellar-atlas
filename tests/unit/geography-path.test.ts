import { describe, expect, it } from "vitest";

import {
  buildGeoPath,
  type GeoRow,
} from "@/data/repositories/cellar-repository";

describe("canonical geography paths", () => {
  it("keeps the most-specific region when regions are nested", () => {
    const geography = new Map<string, GeoRow>([
      [
        "us",
        {
          id: "us",
          parent_id: null,
          level: "country",
          name: "United States",
          country_code: "US",
        },
      ],
      [
        "california",
        {
          id: "california",
          parent_id: "us",
          level: "region",
          name: "California",
          country_code: "US",
        },
      ],
      [
        "napa",
        {
          id: "napa",
          parent_id: "california",
          level: "region",
          name: "Napa Valley",
          country_code: "US",
        },
      ],
    ]);

    const path = buildGeoPath("napa", null, geography);

    expect(path.country?.name).toBe("United States");
    expect(path.region?.name).toBe("Napa Valley");
    expect(path.unmatched).toBeNull();
  });

  it("uses California when it is the most-specific known region", () => {
    const geography = new Map<string, GeoRow>([
      [
        "us",
        {
          id: "us",
          parent_id: null,
          level: "country",
          name: "United States",
          country_code: "US",
        },
      ],
      [
        "california",
        {
          id: "california",
          parent_id: "us",
          level: "region",
          name: "California",
          country_code: "US",
        },
      ],
    ]);

    const path = buildGeoPath("california", null, geography);

    expect(path.country?.name).toBe("United States");
    expect(path.region?.name).toBe("California");
  });
});
