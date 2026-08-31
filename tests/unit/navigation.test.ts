import { describe, it, expect } from "vitest";
import { NAV } from "@/app/layout/navigation";

describe("navigation", () => {
  it("has exactly five destinations — the mobile bottom-bar ceiling", () => {
    expect(NAV).toHaveLength(5);
  });

  it("opens on Home, not the rack", () => {
    expect(NAV[0]?.path).toBe("/");
    expect(NAV[0]?.label).toBe("Home");
  });

  it("does not promote Rack to top level", () => {
    // Rack is one layout of one storage location, not a peer of Cellar.
    expect(NAV.map((n) => n.label)).not.toContain("Rack");
    expect(NAV.map((n) => n.label)).toContain("Storage");
  });

  it("every path is unique", () => {
    const paths = NAV.map((n) => n.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
