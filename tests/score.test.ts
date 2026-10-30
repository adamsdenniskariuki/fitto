import { describe, expect, it } from "vitest";
import { ProfileSchema } from "../src/config.js";
import { hardFilter } from "../src/filters.js";
import { runGolden } from "../src/golden.js";
import { openAi, providerFromEnv, RateLimitError, type LlmProvider } from "../src/llm/provider.js";
import { finalize } from "../src/normalize.js";
import { buildMessages, cacheKey, failureReason, HeuristicScorer, LlmScorer, parseScore, scoreJobs } from "../src/score.js";
import { emptyState } from "../src/state.js";

const profile = ProfileSchema.parse({
  skills: ["typescript", "postgres"],
  seniority: ["senior"],
  title_keywords: ["engineer"],
  locations: { remote: true, exclude: ["US only"] },
  cv: "PRIVATE-CV-TEXT",
});

const job = (n: number, desc = "typescript postgres") =>
  finalize({
    source: "t",
    sourceId: String(n),
    company: `C${n}`,
    title: "Senior Engineer",
    location: "Remote",
    remote: true,
    url: "u",
    description: desc,
    tags: [],
  });

const good = JSON.stringify({
  score: 82,
  fit_summary: "Good",
  matched_skills: ["typescript"],
  gaps: [],
  red_flags: [],
  confidence: "high",
});

class MockProvider implements LlmProvider {
  name = "mock";
  calls = 0;
  constructor(private readonly reply: (n: number) => string | Error) {}
  async complete(): Promise<string> {
    const r = this.reply(++this.calls);
    if (r instanceof Error) throw r;
    return r;
  }
}

describe("golden set (heuristic scorer, LLM mocked)", () => {
  it("all cases fall in their expected bands / filters", async () => {
    const results = await runGolden(new HeuristicScorer());
    const failures = results.filter((r) => !r.ok);
    expect(failures).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(10);
  });
});

describe("hard filters", () => {
  it("passes unknown seniority and rejects other levels", () => {
    const j = job(1);
    expect(hardFilter({ ...j, title: "Software Engineer" }, profile).pass).toBe(true);
    expect(hardFilter({ ...j, title: "Staff Engineer" }, profile).reason).toBe("seniority");
  });

  it("applies per-currency salary floors", () => {
    const p = ProfileSchema.parse({ salary: { min: 60000, currency: "USD", floors: { EUR: 55000, gbp: 50000 } } });
    const at = (currency: string | undefined, max: number) =>
      hardFilter({ ...job(2), salary: { currency, min: max - 10000, max, period: "year" } }, p).pass;
    expect(at("USD", 50000)).toBe(false);
    expect(at("USD", 70000)).toBe(true);
    expect(at("EUR", 50000)).toBe(false);
    expect(at("EUR", 56000)).toBe(true);
    expect(at("GBP", 45000)).toBe(false);
    expect(at(undefined, 50000)).toBe(false);
    expect(at("AED", 1000)).toBe(true); // no floor for that currency: not filtered
  });
});

describe("parseScore", () => {
  it("extracts JSON from noisy output and clamps types", () => {
    const r = parseScore('Sure!\n```json\n{"score":"77.6","fit_summary":"x","confidence":"HIGH?"}\n```');
    expect(r.score).toBe(78);
    expect(r.confidence).toBe("medium");
    expect(r.matched_skills).toEqual([]);
  });
  it("rejects out-of-range scores", () => {
    expect(() => parseScore('{"score":140}')).toThrow();
  });
});

describe("prompt", () => {
  it("contains profile and job, and warns about injected instructions", () => {
    const m = buildMessages(job(1), profile, [{ title: "T", company: "X", verdict: "liked", note: "applied" }]);
    expect(m[0]!.content).toMatch(/untrusted/);
    expect(m[1]!.content).toContain("PRIVATE-CV-TEXT");
    expect(m[1]!.content).toContain("LIKED");
  });
});

describe("scoreJobs", () => {
  const setup = (n: number) => {
    const s = emptyState();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const j = job(i, i === 0 ? "typescript postgres" : "cobol");
      s.jobs[j.id] = { job: j, firstSeen: "x", lastSeen: "x", status: "new", history: [] };
      ids.push(j.id);
    }
    return { s, ids };
  };

  it("caps calls, prioritises by prerank and caches", async () => {
    const { s, ids } = setup(5);
    const p = new MockProvider(() => good);
    const stats = await scoreJobs(s, ids, { scorer: new LlmScorer(p), profile, maxCalls: 2 });
    expect(stats).toMatchObject({ calls: 2, deferred: 3, cacheHits: 0 });
    expect(s.jobs[ids[0]!]!.score?.final).toBe(82);

    const again = await scoreJobs(s, ids, { scorer: new LlmScorer(p), profile, maxCalls: 10 });
    expect(again.cacheHits).toBe(2);
    expect(again.calls).toBe(3);
    expect(p.calls).toBe(5);
  });

  it("applies learned adjustments and clamps", async () => {
    const { s, ids } = setup(1);
    await scoreJobs(s, ids, { scorer: new LlmScorer(new MockProvider(() => good)), profile, maxCalls: 1, adjust: () => 30 });
    expect(s.jobs[ids[0]!]!.score).toMatchObject({ score: 82, adjustment: 30, final: 100 });
  });

  it("retries bad JSON once, then records a failure", async () => {
    const { s, ids } = setup(2);
    const p = new MockProvider((n) => (n <= 3 ? "not json" : good));
    const stats = await scoreJobs(s, ids, { scorer: new LlmScorer(p), profile, maxCalls: 5 });
    expect(stats.failures).toBe(1);
    expect(p.calls).toBe(4);
  });

  it("stops on rate limit and defers the rest", async () => {
    const { s, ids } = setup(3);
    const p = new MockProvider(() => new RateLimitError("429"));
    const stats = await scoreJobs(s, ids, { scorer: new LlmScorer(p), profile, maxCalls: 5 });
    expect(stats.rateLimited).toBe(true);
    expect(p.calls).toBe(1);
    expect(stats.deferred).toBe(3);
  });

  it("cache key changes with the profile and the posting", () => {
    const j = job(1);
    const p2 = ProfileSchema.parse({ ...profile, skills: ["go"] });
    expect(cacheKey(j, profile)).not.toBe(cacheKey(j, p2));
    expect(cacheKey(j, profile)).not.toBe(cacheKey({ ...j, description: "changed" }, profile));
  });
});

describe("providers", () => {
  it("selects providers from env", () => {
    expect(providerFromEnv({})).toBeUndefined();
    expect(providerFromEnv({ GITHUB_TOKEN: "t" })).toBeUndefined();
    expect(() => providerFromEnv({ FITTO_LLM: "github", GITHUB_TOKEN: "t" })).toThrow(/retired/);
    expect(providerFromEnv({ GITHUB_TOKEN: "t", OPENAI_API_KEY: "k" })?.name).toMatch(/^openai:/);
    expect(providerFromEnv({ GITHUB_TOKEN: "t", FITTO_LLM: "heuristic" })).toBeUndefined();
  });
  it("calls OpenAI with JSON mode and maps 429", async () => {
    let body: Record<string, unknown> = {};
    let auth = "";
    const ok = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: good } }] }));
    }) as typeof fetch;
    await expect(openAi("tok", undefined, ok).complete([{ role: "user", content: "hi" }])).resolves.toBe(good);
    expect(body).toMatchObject({ model: "gpt-4.1-mini", response_format: { type: "json_object" } });
    expect(auth).toBe("Bearer tok");
    const limited = (async () => new Response("", { status: 429 })) as typeof fetch;
    await expect(openAi("tok", undefined, limited).complete([])).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("scoring failure diagnostics", () => {
  it("reports HTTP errors with API error code but no response details", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: "tokens_limit_reached", message: "secret details" } }), { status: 413 })) as typeof fetch;
    const err = await openAi("t", undefined, fetchImpl).complete([]).catch((e) => e);
    expect(failureReason(err)).toBe("HTTP 413 (tokens_limit_reached)");
  });
  it("classifies non-JSON 200 responses", async () => {
    const fetchImpl = (async () => new Response("OK", { status: 200 })) as typeof fetch;
    const err = await openAi("t", undefined, fetchImpl).complete([]).catch((e) => e);
    expect(failureReason(err)).toBe("invalid response");
  });
  it("counts failures by reason in scoreJobs stats", async () => {
    const state = emptyState();
    const j = job(1);
    state.jobs[j.id] = { job: j, firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z" } as never;
    const scorer = { name: "x", score: async () => { throw new Error("x returned HTTP 500"); } };
    const s = await scoreJobs(state, [j.id], { scorer, profile, maxCalls: 5 });
    expect(s.errors).toEqual({ "HTTP 500": 1 });
  });
});
describe("lenient score parsing", () => {
  it("truncates oversized fields instead of rejecting", () => {
    const r = parseScore(
      JSON.stringify({
        score: "82.4",
        fit_summary: "x".repeat(2000),
        matched_skills: Array.from({ length: 50 }, (_, i) => `s${i}`),
        gaps: "one gap",
        red_flags: null,
        confidence: "very high",
      }),
    );
    expect(r.score).toBe(82);
    expect(r.fit_summary).toHaveLength(1200);
    expect(r.matched_skills).toHaveLength(30);
    expect(r.gaps).toEqual(["one gap"]);
    expect(r.red_flags).toEqual([]);
    expect(r.confidence).toBe("medium");
  });
  it("names mismatched fields in the failure reason", () => {
    let err: unknown;
    try {
      parseScore('{"score":"n/a"}');
    } catch (e) {
      err = e;
    }
    expect(failureReason(err)).toBe("schema mismatch (score)");
  });
});