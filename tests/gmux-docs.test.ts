import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

describe("gmux docs + bindings", () => {
  it("ships a gmux doc covering the guardian consent and memory caveats", () => {
    expect(existsSync("docs/gmux.md")).toBe(true);
    const doc = readFileSync("docs/gmux.md", "utf8");
    expect(doc).toMatch(/guardian/i);
    expect(doc).toMatch(/unattributed/i);
    expect(doc).toMatch(/consent|disclose/i);
  });
});
