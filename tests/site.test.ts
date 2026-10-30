import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { finalize } from "../src/normalize.js";
import { buildSitePayload, encryptForSite } from "../src/site.js";
import { emptyState, type JobRecord, type State } from "../src/state.js";
import {
  CorsBlockedError,
  decryptEnvelope,
  DispatchError,
  dispatchToAction,
  effectiveSend,
  isSelectable,
  MemoryKV,
  sendDirect,
  SiteStore,
  WrongPassphraseError,
} from "../site/src/core.js";

const PASS = "correct horse battery staple";
const ITER = 100_000; // the minimum the site accepts; keeps tests fast
const TNC = "https://thenextchapter.dev";

function record(id: string, final: number, extra: Partial<JobRecord> = {}): JobRecord {
  const job = {
    ...finalize({ source: "greenhouse", sourceId: id, company: id === "a1" ? "Stripe" : "Acme", title: `Engineer ${id}`, location: "Remote", remote: true, url: `https://boards.example.com/jobs/${id}`, description: "", tags: [] }),
    id,
  };
  return {
    job,
    firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-01-02T00:00:00Z",
    status: "new",
    history: [],
    score: { score: final, final, adjustment: 0, fit_summary: `Secret summary ${id}`, matched_skills: ["go"], gaps: [], red_flags: [], confidence: "high", provider: "mock", cacheKey: "k", scoredAt: "x" },
    ...extra,
  };
}

function sampleState(): State {
  const s = emptyState();
  s.jobs.a1 = record("a1", 91);
  s.jobs.b2 = record("b2", 70);
  s.jobs.c3 = record("c3", 40);
  s.jobs.d4 = record("d4", 95, { status: "no" });
  s.jobs.e5 = record("e5", 30);
  s.submissions.e5 = { state: "accepted", detail: "accepted", key: "k", at: "x", updatedAt: "2026-01-03T00:00:00Z", attempts: 1 };
  s.drafts.a1 = { cv_bullets: ["Did a thing"], cover_note: "Hello", createdAt: "x", provider: "mock" };
  return s;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
function mockFetch(replies: Reply[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies.shift();
    if (!r) throw new Error("unexpected call");
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const sleeps: number[] = [];
  return { calls, sleeps, fetchImpl, sleep: async (ms: number) => void sleeps.push(ms) };
}
const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

describe("site export", () => {
  it("includes matches at or above the min score, plus submitted jobs, and hides closed ones", () => {
    const p = buildSitePayload(sampleState(), { minScore: 60, repo: "o/r", now: new Date("2026-01-04T00:00:00Z") });
    expect(p.jobs.map((j) => j.id)).toEqual(["a1", "b2", "e5"]);
    expect(p.jobs[0]).toMatchObject({ draft: { cv_bullets: ["Did a thing"] }, devprep: "https://devprep.madebyfavor.com/#company/stripe" });
    expect(p.jobs[2]!.submission).toEqual({ state: "accepted", detail: "accepted", updatedAt: "2026-01-03T00:00:00Z" });
  });

  it("publishes only ciphertext and round-trips through the browser decryptor", async () => {
    const payload = buildSitePayload(sampleState(), { minScore: 60, repo: "o/r" });
    const env = encryptForSite(payload, PASS, ITER);
    const text = JSON.stringify(env);
    for (const leak of ["Secret summary", "Engineer", "boards.example.com", "Stripe"]) expect(text).not.toContain(leak);
    expect(env).toMatchObject({ v: 1, kdf: "PBKDF2-SHA256", alg: "AES-256-GCM", iter: ITER });
    expect(await decryptEnvelope(env, PASS)).toEqual(payload);
    // A fresh salt and IV every time.
    expect(encryptForSite(payload, PASS, ITER).ct).not.toBe(env.ct);
  });

  it("rejects a wrong passphrase, tampering, weak settings and short passphrases", async () => {
    const env = encryptForSite({ v: 1, generatedAt: "x", repo: "o/r", jobs: [] }, PASS, ITER);
    await expect(decryptEnvelope(env, "wrong passphrase!")).rejects.toBeInstanceOf(WrongPassphraseError);
    const ct = Buffer.from(env.ct, "base64");
    ct[0]! ^= 1;
    await expect(decryptEnvelope({ ...env, ct: ct.toString("base64") }, PASS)).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(decryptEnvelope({ ...env, iter: 1000 }, PASS)).rejects.toThrow(/Unsupported/);
    expect(() => encryptForSite({}, "short")).toThrow(/12 characters/);
  });
});

describe("site: GitHub Action route", () => {
  it("dispatches one fitto-tnc run with only opaque ids", async () => {
    const m = mockFetch([{ status: 204 }]);
    await dispatchToAction(["1bdaa62bca", "7f3e0c11aa"], { token: "github_pat_x", repo: "o/r", fetchImpl: m.fetchImpl });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url).toBe("https://api.github.com/repos/o/r/actions/workflows/fitto-tnc.yml/dispatches");
    expect(header(m.calls[0]!.init, "authorization")).toBe("Bearer github_pat_x");
    expect(JSON.parse(String(m.calls[0]!.init!.body))).toEqual({ ref: "main", inputs: { ids: "1bdaa62bca,7f3e0c11aa" } });
  });

  it("explains permission errors and validates input", async () => {
    await expect(dispatchToAction(["1bdaa62bca"], { token: "t", fetchImpl: mockFetch([{ status: 403 }]).fetchImpl })).rejects.toThrow(/Actions: Read and write/);
    await expect(dispatchToAction(["https://x"], { token: "t", fetchImpl: mockFetch([]).fetchImpl })).rejects.toBeInstanceOf(DispatchError);
    await expect(dispatchToAction(Array(51).fill("abcdef"), { token: "t" })).rejects.toThrow(/at most 50/);
    await expect(dispatchToAction(["abcdef"], { token: "" })).rejects.toThrow(/token/);
  });
});

describe("site: Direct API route", () => {
  const jobs = [
    { id: "a1", url: "https://boards.example.com/jobs/a1" },
    { id: "b2", url: "https://boards.example.com/jobs/b2" },
  ];

  it("CORS ok: posts each URL sequentially with the shared idempotency key and polls politely", async () => {
    const m = mockFetch([
      { status: 202, body: { statusUrl: `${TNC}/api/v1/submissions/s1` }, headers: { "Retry-After": "7" } },
      { status: 200, body: { status: "accepted" } },
      { status: 202, body: { statusUrl: `${TNC}/api/v1/submissions/s2` } },
      { status: 200, body: { status: "failed" } },
    ]);
    const progress: string[] = [];
    const res = await sendDirect(jobs, { token: "tnc-tok", fetchImpl: m.fetchImpl, sleep: m.sleep, onProgress: (id, r) => progress.push(`${id}:${r.state}`) });
    expect(res.a1!.state).toBe("accepted");
    expect(res.b2!.state).toBe("failed");
    expect(progress).toEqual(["a1:accepted", "b2:failed"]);
    expect(m.calls.map((c) => `${c.init?.method ?? "GET"} ${c.url.replace(TNC, "")}`)).toEqual([
      "POST /api/v1/submissions",
      "GET /api/v1/submissions/s1",
      "POST /api/v1/submissions",
      "GET /api/v1/submissions/s2",
    ]);
    const post = m.calls[0]!.init;
    expect(header(post, "idempotency-key")).toBe("fitto-" + createHash("sha256").update(jobs[0]!.url).digest("hex").slice(0, 32));
    expect(header(post, "authorization")).toBe("Bearer tnc-tok");
    expect(header(post, "user-agent")).toBeNull();
    expect(JSON.parse(String(post!.body))).toEqual({ url: jobs[0]!.url });
    // Retry-After (7 s) honoured, 5 s minimum between status checks, and a gap between POSTs.
    expect(m.sleeps).toEqual([7000, 3000, 5000]);
  });

  it("CORS blocked: the first request's TypeError surfaces as CorsBlockedError without retries", async () => {
    const m = mockFetch([new TypeError("Failed to fetch")]);
    await expect(sendDirect(jobs, { token: "tnc-tok", fetchImpl: m.fetchImpl, sleep: m.sleep })).rejects.toBeInstanceOf(CorsBlockedError);
    expect(m.calls).toHaveLength(1);
    expect(new CorsBlockedError().message).toMatch(/doesn't allow browser requests yet/);
  });

  it("a network error on a later job marks only that job failed", async () => {
    const m = mockFetch([{ status: 200, body: { status: "accepted" } }, new TypeError("Failed to fetch")]);
    const res = await sendDirect(jobs, { token: "tnc-tok", fetchImpl: m.fetchImpl, sleep: m.sleep });
    expect(res).toMatchObject({ a1: { state: "accepted" }, b2: { state: "failed", detail: "network" } });
  });
});

describe("site: local store and selection", () => {
  it("keeps secrets in session storage unless remembered, and never exports them", () => {
    const local = new MemoryKV();
    const session = new MemoryKV();
    const s = new SiteStore(local, session);
    s.setSecret("ghToken", "github_pat_secret", false);
    expect(local.getItem("fitto.ghToken")).toBeNull();
    expect(s.getSecret("ghToken")).toBe("github_pat_secret");
    s.setSecret("tncToken", "tnc_secret", true);
    expect(s.isRemembered("tncToken")).toBe(true);
    s.setStatus("1bdaa62bca", "applied", new Date("2026-01-01T00:00:00Z"));
    const out = s.exportData();
    expect(out).not.toContain("secret");
    s.forgetAll();
    expect(s.getSecret("tncToken")).toBeUndefined();
    expect(s.statuses).toEqual({});
    expect(s.importData(out)).toEqual({ statuses: 1, sends: 0 });
    expect(s.statuses["1bdaa62bca"]!.status).toBe("applied");
    expect(() => s.importData('{"nope":1}')).toThrow(/Fitto export/);
  });

  it("drops invalid entries on import and keeps the newest", () => {
    const s = new SiteStore(new MemoryKV(), new MemoryKV());
    s.setStatus("abcdef", "saved", new Date("2026-02-01T00:00:00Z"));
    const r = s.importData(
      JSON.stringify({
        fitto: 1,
        statuses: { abcdef: { status: "applied", at: "2026-01-01T00:00:00Z" }, "<script>": { status: "saved", at: "x" }, bcdefa: { status: "hacked", at: "x" } },
        sends: { abcdef: { state: "accepted", detail: "ok", at: "2026-01-01T00:00:00Z", via: "direct" } },
      }),
    );
    expect(r).toEqual({ statuses: 0, sends: 1 });
    expect(s.statuses.abcdef!.status).toBe("saved");
  });

  it("disables already sent jobs but lets failed ones be retried", () => {
    const server = { submission: { state: "accepted", detail: "", updatedAt: "2026-01-02T00:00:00Z" } };
    expect(isSelectable(effectiveSend({}))).toBe(true);
    expect(isSelectable(effectiveSend(server))).toBe(false);
    const queued = { state: "queued" as const, detail: "", at: "2026-01-03T00:00:00Z", via: "action" as const };
    expect(isSelectable(effectiveSend({}, queued))).toBe(false);
    const failedLater = { submission: { state: "failed", detail: "http-500", updatedAt: "2026-01-04T00:00:00Z" } };
    expect(effectiveSend(failedLater, queued)!.source).toBe("server");
    expect(isSelectable(effectiveSend(failedLater, queued))).toBe(true);
  });

  it("defaults to GitHub Action mode and validates the repo", () => {
    const s = new SiteStore(new MemoryKV(), new MemoryKV());
    expect(s.settings).toEqual({ mode: "action", repo: "adamsdenniskariuki/fitto" });
    s.saveSettings({ mode: "direct", repo: "bad repo/../x" });
    expect(s.settings).toEqual({ mode: "direct", repo: "adamsdenniskariuki/fitto" });
  });
});
