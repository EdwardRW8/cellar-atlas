import { describe, it, expect } from "vitest";
import { classifyError } from "@/data/repositories/repository";

describe("error classification drives retry behaviour", () => {
  it("unique violation means a previous attempt already landed", () => {
    expect(classifyError({ code: "23505" })).toBe("duplicate");
  });

  it("constraint violations are permanent — retrying invalid data is pointless", () => {
    expect(classifyError({ code: "23503" })).toBe("permanent");
    expect(classifyError({ code: "23502" })).toBe("permanent");
    expect(classifyError({ code: "23514" })).toBe("permanent");
  });

  it("RLS denial is permanent", () => {
    expect(classifyError({ code: "42501" })).toBe("permanent");
  });

  it("version mismatch is a conflict needing resolution", () => {
    expect(classifyError({ code: "P0001", message: "version mismatch" })).toBe("conflict");
  });

  it("auth failures are permanent", () => {
    expect(classifyError({ status: 401 })).toBe("permanent");
    expect(classifyError({ status: 403 })).toBe("permanent");
  });

  it("network and server errors are retryable", () => {
    expect(classifyError({ status: 500 })).toBe("retryable");
    expect(classifyError({ status: 503 })).toBe("retryable");
    expect(classifyError(new Error("Failed to fetch"))).toBe("retryable");
    expect(classifyError(null)).toBe("retryable");
  });
});
