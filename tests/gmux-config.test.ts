import { describe, expect, it } from "vitest";
import { resolveGmuxConfig } from "../src/services/config.js";
import { DEFAULT_GMUX_CONFIG } from "../src/core/gmux-types.js";

describe("resolveGmuxConfig", () => {
  it("defaults to auto-broadcast when unset", () => {
    expect(resolveGmuxConfig(null)).toEqual(DEFAULT_GMUX_CONFIG);
  });
  it("honors a stored policy and fills the rest", () => {
    const cfg = {
      version: 1,
      provider: null,
      autoSummarize: false,
      gmux: { guardianPolicy: "off" as const, memoryThreshold: 0.8, cooldownSeconds: 120, tickMs: 2000 },
    };
    expect(resolveGmuxConfig(cfg).guardianPolicy).toBe("off");
    expect(resolveGmuxConfig(cfg).memoryThreshold).toBe(0.8);
  });
  it("fills defaults for a partial gmux block", () => {
    const cfg = {
      version: 1,
      provider: null,
      autoSummarize: false,
      gmux: { guardianPolicy: "notify" as const } as any,
    };
    const r = resolveGmuxConfig(cfg);
    expect(r.guardianPolicy).toBe("notify");
    expect(r.cooldownSeconds).toBe(DEFAULT_GMUX_CONFIG.cooldownSeconds);
  });
});
