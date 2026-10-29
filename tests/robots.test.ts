import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots } from "../src/robots.js";

describe("robots", () => {
  const txt = `
User-agent: *
Disallow: /api
Allow: /api/public

User-agent: badbot
Disallow: /
`;
  it("applies the * group with longest match", () => {
    const r = parseRobots(txt, "fitto");
    expect(isAllowed(r, "/jobs")).toBe(true);
    expect(isAllowed(r, "/api/remote-jobs")).toBe(false);
    expect(isAllowed(r, "/api/public/x")).toBe(true);
  });
  it("prefers a specific agent group", () => {
    const r = parseRobots(txt, "badbot/1.0");
    expect(isAllowed(r, "/anything")).toBe(false);
  });
  it("allows everything for empty robots", () => {
    expect(isAllowed(parseRobots("", "fitto"), "/x")).toBe(true);
  });
});
