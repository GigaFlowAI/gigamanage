import { describe, expect, it } from "vitest";

import { hammingDistance, simhash64 } from "../src/core/fingerprint.js";

const A =
  "Implemented the retry backoff and fixed the webhook signature check. Tests are green except the timestamp case.";

describe("simhash64", () => {
  it("is a fixed 16 hex characters regardless of input length", () => {
    expect(simhash64("short")).toMatch(/^[0-9a-f]{16}$/);
    expect(simhash64(A.repeat(50))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", () => {
    expect(simhash64(A)).toBe(simhash64(A));
  });

  it("gives identical text a distance of 0", () => {
    expect(hammingDistance(simhash64(A), simhash64(A))).toBe(0);
  });

  it("gives a small edit a small distance", () => {
    const edited = `${A} One more line about the timestamp fix.`;
    expect(hammingDistance(simhash64(A), simhash64(edited))).toBeLessThan(12);
  });

  it("gives unrelated text a large distance", () => {
    const other =
      "Designing the event-driven architecture: a queue per tenant, a dispatcher, and a dead-letter path for poisoned messages.";
    expect(hammingDistance(simhash64(A), simhash64(other))).toBeGreaterThan(12);
  });
});

describe("hammingDistance", () => {
  it("counts differing bits between two fingerprints", () => {
    expect(hammingDistance("0000000000000000", "0000000000000001")).toBe(1);
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4);
    expect(hammingDistance("ffffffffffffffff", "fffffffffffffff0")).toBe(4);
  });

  it("is 0 for equal fingerprints", () => {
    expect(hammingDistance("abc123abc123abc1", "abc123abc123abc1")).toBe(0);
  });
});
