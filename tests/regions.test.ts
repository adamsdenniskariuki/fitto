import { describe, expect, it } from "vitest";
import { ProfileSchema, profileHash } from "../src/config.js";
import { finalize } from "../src/normalize.js";
import { regionBoost, regionRank } from "../src/regions.js";
import { prerank } from "../src/score.js";

const profile = ProfileSchema.parse({ skills: ["go"], locations: { priority: ["Kenya", "Europe", "Middle East", "USA"] } });
const job = (location: string) =>
  finalize({ source: "t", sourceId: location, company: "Acme", title: "Engineer", location, remote: true, url: "u", description: "go", tags: [] });

describe("region priority", () => {
  it("ranks locations in profile order", () => {
    expect(regionRank(job("Nairobi, Kenya"), profile)).toBe(0);
    expect(regionRank(job("Remote - Europe"), profile)).toBe(1);
    expect(regionRank(job("Berlin, Germany"), profile)).toBe(1);
    expect(regionRank(job("Remote (EMEA)"), profile)).toBe(1);
    expect(regionRank(job("Dubai, UAE"), profile)).toBe(2);
    expect(regionRank(job("New York, NY, United States"), profile)).toBe(3);
    expect(regionRank(job("Remote, US"), profile)).toBe(3);
    expect(regionRank(job("Remote - Worldwide"), profile)).toBe(-1);
    expect(regionRank(job("São Paulo, Latin America"), profile)).toBe(-1);
  });

  it("does not match short terms inside words", () => {
    expect(regionRank(job("Remote, Australia"), profile)).toBe(-1);
    expect(regionRank(job("Estonia"), profile)).toBe(1);
  });

  it("gives decreasing boosts", () => {
    expect(["Kenya", "Paris", "Doha", "Seattle", "Anywhere"].map((l) => regionBoost(job(l), profile).points)).toEqual([10, 8, 5, 3, 0]);
  });

  it("matches custom entries literally and respects priority_boost", () => {
    const p = ProfileSchema.parse({ locations: { priority: ["Kigali"], priority_boost: 6 } });
    expect(regionBoost(job("Kigali, Rwanda"), p)).toEqual({ points: 6, region: "Kigali" });
  });

  it("feeds the LLM budget pre-rank", () => {
    expect(prerank(job("Nairobi"), profile)).toBeGreaterThan(prerank(job("Seattle"), profile));
  });

  it("does not change the profile hash, so cached scores stay valid", () => {
    const plain = ProfileSchema.parse({ skills: ["go"] });
    expect(profileHash(profile)).toBe(profileHash(plain));
  });
});
