import { describe, expect, it } from "vitest";
import { dedupe, finalize, htmlToText, isFresh, jobId, parseSalary } from "../src/normalize.js";
import type { RawJob } from "../src/types.js";

const raw = (over: Partial<RawJob> = {}): RawJob => ({
  source: "greenhouse",
  sourceId: "acme/1",
  company: "Acme Inc.",
  title: "Senior Backend Engineer",
  location: "Remote",
  remote: true,
  url: "https://example.com/1",
  description: "desc",
  tags: [],
  ...over,
});

describe("htmlToText", () => {
  it("strips tags and decodes double-encoded html", () => {
    expect(htmlToText("&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;TS&lt;/li&gt;&lt;/ul&gt;")).toBe(
      "Hello & welcome\n• TS",
    );
  });
  it("handles empty input", () => {
    expect(htmlToText(undefined)).toBe("");
  });
});

describe("parseSalary", () => {
  it("parses k ranges with symbols", () => {
    expect(parseSalary("Pay: $120k – $150k plus equity")).toEqual({
      min: 120000,
      max: 150000,
      currency: "USD",
      period: "year",
    });
  });
  it("parses numeric ranges with trailing currency", () => {
    expect(parseSalary("80,000 - 95,000 EUR")).toMatchObject({ min: 80000, max: 95000, currency: "EUR" });
  });
  it("ignores text without currency", () => {
    expect(parseSalary("5-10 years of experience")).toBeUndefined();
  });
});

describe("ids and dedupe", () => {
  it("keyed ids differ from unkeyed ids and are stable", () => {
    expect(jobId("a", "1")).toBe(jobId("a", "1"));
    expect(jobId("a", "1", "secret")).not.toBe(jobId("a", "1"));
    expect(jobId("a", "1")).toHaveLength(10);
  });
  it("dedupes across sources preferring ATS", () => {
    const a = finalize(raw({ source: "remoteok", sourceId: "9", company: "ACME" }));
    const b = finalize(raw());
    const c = finalize(raw({ sourceId: "acme/2", title: "Staff Engineer" }));
    const out = dedupe([a, b, c]);
    expect(out).toHaveLength(2);
    expect(out.find((j) => j.title.startsWith("Senior"))?.source).toBe("greenhouse");
  });
  it("filters stale postings", () => {
    const now = Date.parse("2026-01-31T00:00:00Z");
    expect(isFresh(finalize(raw({ postedAt: "2026-01-20T00:00:00Z" })), 30, now)).toBe(true);
    expect(isFresh(finalize(raw({ postedAt: "2025-11-01T00:00:00Z" })), 30, now)).toBe(false);
    expect(isFresh(finalize(raw()), 30, now)).toBe(true);
  });
});
