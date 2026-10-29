import { describe, expect, it } from "vitest";
import { HttpClient, HttpError, RobotsDisallowedError, USER_AGENT } from "../src/http.js";
import { fetchAshby, fetchGreenhouse, fetchLever, fetchWorkable } from "../src/sources/ats.js";
import { fetchHn, fetchRemoteOk, parseWwrRss } from "../src/sources/boards.js";
import { buildTasks, fetchAll } from "../src/sources/index.js";
import { CompaniesSchema } from "../src/config.js";

type Routes = Record<string, unknown>;

function fakeHttp(routes: Routes, seen: { url: string; ua: string | null }[] = []) {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, ua: headers.get("user-agent") });
    if (url.endsWith("/robots.txt")) {
      const body = routes["robots"] as string | undefined;
      return new Response(body ?? "", { status: body ? 200 : 404 });
    }
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    const v = routes[key];
    if (typeof v === "number") return new Response("err", { status: v });
    return new Response(typeof v === "string" ? v : JSON.stringify(v), { status: 200 });
  }) as typeof fetch;
  return new HttpClient({ fetchImpl, minIntervalMs: 0, sleep: async () => {} });
}

describe("http client", () => {
  it("sends a clear user agent and respects robots.txt", async () => {
    const seen: { url: string; ua: string | null }[] = [];
    const http = fakeHttp({ robots: "User-agent: *\nDisallow: /private", "/ok": { a: 1 } }, seen);
    await expect(http.json("https://x.test/ok")).resolves.toEqual({ a: 1 });
    await expect(http.json("https://x.test/private/1")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(seen.every((s) => s.ua === USER_AGENT)).toBe(true);
  });
  it("retries 5xx then throws HttpError", async () => {
    let calls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
      calls++;
      return new Response("", { status: 503 });
    }) as typeof fetch;
    const http = new HttpClient({ fetchImpl, minIntervalMs: 0, retries: 2, sleep: async () => {} });
    await expect(http.json("https://x.test/a")).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(3);
  });
});

describe("ATS connectors", () => {
  it("greenhouse", async () => {
    const http = fakeHttp({
      "boards-api.greenhouse.io/v1/boards/acme/jobs": {
        jobs: [
          {
            id: 1,
            title: "Senior Engineer",
            absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
            location: { name: "Remote - EMEA" },
            updated_at: "2026-01-01T00:00:00Z",
            content: "&lt;p&gt;Salary $100k-$120k&lt;/p&gt;",
          },
        ],
      },
    });
    const [j] = await fetchGreenhouse(http, "acme", "Acme");
    expect(j).toMatchObject({ source: "greenhouse", sourceId: "acme/1", remote: true, company: "Acme" });
    expect(j!.salary).toMatchObject({ min: 100000, max: 120000 });
  });

  it("lever", async () => {
    const http = fakeHttp({
      "api.lever.co/v0/postings/acme": [
        {
          id: "abc",
          text: "Backend Engineer",
          hostedUrl: "https://jobs.lever.co/acme/abc",
          createdAt: 1767225600000,
          descriptionPlain: "Build things",
          workplaceType: "remote",
          categories: { location: "Nairobi", team: "Platform" },
          salaryRange: { min: 50, max: 70, currency: "USD", interval: "per-hour-wage" },
        },
      ],
    });
    const [j] = await fetchLever(http, "acme", "Acme");
    expect(j).toMatchObject({ remote: true, location: "Nairobi", salary: { period: "hour", min: 50 } });
    expect(j!.tags).toContain("Platform");
  });

  it("ashby", async () => {
    const http = fakeHttp({
      "api.ashbyhq.com/posting-api/job-board/acme": {
        jobs: [
          {
            id: "u1",
            title: "Staff Engineer",
            location: "London",
            isRemote: false,
            jobUrl: "https://jobs.ashbyhq.com/acme/u1",
            descriptionPlain: "Do work",
            compensation: {
              summaryComponents: [
                { compensationType: "Salary", interval: "1 YEAR", currencyCode: "GBP", minValue: 90000, maxValue: 110000 },
              ],
            },
          },
          { id: "u2", title: "Hidden", jobUrl: "x", isListed: false },
        ],
      },
    });
    const jobs = await fetchAshby(http, "acme", "Acme");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ remote: false, salary: { currency: "GBP", min: 90000, period: "year" } });
  });

  it("workable", async () => {
    const http = fakeHttp({
      "apply.workable.com/api/v1/widget/accounts/acme": {
        jobs: [
          {
            title: "Engineer",
            shortcode: "AB12",
            url: "https://apply.workable.com/j/AB12",
            city: "Nairobi",
            country: "Kenya",
            telecommuting: true,
            description: "<p>Hi</p>",
          },
        ],
      },
    });
    const [j] = await fetchWorkable(http, "acme", "Acme");
    expect(j).toMatchObject({ sourceId: "acme/AB12", location: "Nairobi, Kenya", remote: true, description: "Hi" });
  });
});

describe("board connectors", () => {
  it("remoteok skips the legal notice and keeps attribution", async () => {
    const http = fakeHttp({
      "remoteok.com/api": [
        { legal: "terms" },
        { id: 5, company: "Acme", position: "Dev", url: "https://remoteok.com/remote-jobs/5", salary_min: 0, tags: ["ts"] },
      ],
    });
    const jobs = await fetchRemoteOk(http);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.attribution).toMatch(/Remote OK/);
    expect(jobs[0]!.salary).toBeUndefined();
  });

  it("we work remotely rss", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Acme: Senior Rails Developer</title><region>Anywhere in the World</region>
      <link>https://weworkremotely.com/remote-jobs/acme-1</link><guid>https://weworkremotely.com/remote-jobs/acme-1</guid>
      <pubDate>Mon, 05 Jan 2026 10:00:00 +0000</pubDate><description>&lt;p&gt;Great job&lt;/p&gt;</description></item>
    </channel></rss>`;
    const [j] = parseWwrRss(xml);
    expect(j).toMatchObject({ company: "Acme", title: "Senior Rails Developer", location: "Remote (Anywhere in the World)" });
    expect(j!.description).toBe("Great job");
  });

  it("hn who is hiring", async () => {
    const http = fakeHttp({
      "search_by_date": { hits: [{ objectID: "100", title: "Ask HN: Who is hiring? (January 2026)" }] },
      "story_100": {
        hits: [
          { objectID: "1", parent_id: 100, comment_text: "Acme | Senior Backend Engineer | REMOTE (EU) | $150k<p>We build..." },
          { objectID: "2", parent_id: 1, comment_text: "a reply" },
          { objectID: "3", parent_id: 100, comment_text: "no pipes here" },
        ],
      },
    });
    const jobs = await fetchHn(http, 100);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ company: "Acme", title: "Senior Backend Engineer", remote: true });
  });
});

describe("fetchAll", () => {
  it("collects stats, survives failures and dedupes", async () => {
    const http = fakeHttp({
      "boards/good/jobs": { jobs: [{ id: 1, title: "Engineer", absolute_url: "https://x/1", location: { name: "Remote" } }] },
      "boards/bad/jobs": 500,
    });
    const cfg = CompaniesSchema.parse({
      companies: [
        { name: "Good", ats: "greenhouse", slug: "good" },
        { name: "Bad", ats: "greenhouse", slug: "bad" },
      ],
    });
    const res = await fetchAll(buildTasks(http, cfg), { maxAgeDays: 30 });
    expect(res.jobs).toHaveLength(1);
    expect(res.stats.find((s) => s.label === "greenhouse:bad")?.error).toMatch(/500/);
  });
});
