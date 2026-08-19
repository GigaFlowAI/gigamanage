import { describe, expect, it } from "vitest";
import { renderWorkReportHtml, type WorkReportCard } from "../src/cli/work-report.js";

const at = Date.parse("2026-08-18T12:00:00Z");

describe("renderWorkReportHtml", () => {
  it("is a self-contained page with no external references", () => {
    const html = renderWorkReportHtml([], at);
    expect(html).toContain("<!doctype html>");
    expect(html).not.toMatch(/src=|https?:\/\//); // no external scripts/links/images
    expect(html.toLowerCase()).toContain("no sessions");
  });

  it("sets a restrictive Content-Security-Policy on the shell", () => {
    const html = renderWorkReportHtml([], at);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });

  it("embeds each fragment in a sandboxed iframe srcdoc", () => {
    const cards: WorkReportCard[] = [{ label: "shop", headline: "adding auth", html: "<svg></svg>", note: null }];
    const html = renderWorkReportHtml(cards, at);
    expect(html).toContain("shop");
    expect(html).toContain("adding auth");
    expect(html).toMatch(/<iframe[^>]*sandbox/);
    expect(html).toContain("srcdoc=");
    expect(html).toContain("&lt;svg&gt;"); // fragment is attribute-escaped into srcdoc, not live in the DOM
  });

  it("renders the note when a card has no html, and escapes chrome text", () => {
    const cards: WorkReportCard[] = [
      { label: "a & b <x>", headline: null, html: null, note: "generation failed: boom" },
    ];
    const html = renderWorkReportHtml(cards, at);
    expect(html).toContain("generation failed: boom");
    expect(html).toContain("a &amp; b &lt;x&gt;"); // label escaped in our own chrome
    expect(html).not.toMatch(/<iframe/); // note card has no iframe
  });
});
