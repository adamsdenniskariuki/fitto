import { afterEach, describe, expect, it, vi } from "vitest";
import { finalize } from "../src/normalize.js";
import { classify, DryRunTncSink, idempotencyKey, retryAfterMs, TncSink } from "../src/sinks/tnc.js";
import { emptyState, mergeStates, type State } from "../src/state.js";
import { refreshPending, submitJobs } from "../src/submit.js";

const BASE = "https://tnc.test";
const JOB_URL = "https://boards.example.com/acme/jobs/123";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
interface Call {
  url: string;
  init?: RequestInit;
}

function mockApi(replies: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies.shift();
    if (!r) throw new Error("unexpected call");
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { calls, sleeps, sink: new TncSink({ token: "tok-secret", baseUrl: BASE, fetchImpl, sleep, maxPolls: 4 }) };
}
const header = (c: Call, name: string) => new Headers(c.init?.headers).get(name);

function stateWith(...ids: string[]): State {
  const s = emptyState();
  for (const id of ids) {
    const job = { ...finalize({ source: "t", sourceId: id, company: "Acme", title: "Engineer", location: "Remote", remote: true, url: `${JOB_URL}?j=${id}`, description: "", tags: [] }), id };
    s.jobs[id] = { job, firstSeen: "x", lastSeen: "x", status: "new", history: [] };
  }
  return s;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("TNC helpers", () => {
  it("derives a deterministic idempotency key per URL", async () => {
    expect(await idempotencyKey(JOB_URL)).toBe(await idempotencyKey(` ${JOB_URL} `));
    expect(await idempotencyKey(JOB_URL)).not.toBe(await idempotencyKey(JOB_URL + "4"));
    expect(await idempotencyKey(JOB_URL)).toMatch(/^fitto-[0-9a-f]{32}$/);
    const { createHash } = await import("node:crypto");
    expect(await idempotencyKey(JOB_URL)).toBe("fitto-" + createHash("sha256").update(JOB_URL).digest("hex").slice(0, 32));
  });

  it("parses Retry-After and classifies statuses", () => {
    expect(retryAfterMs("7")).toBe(7000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(classify({ status: "completed" }).state).toBe("accepted");
    expect(classify({ state: "REJECTED" }).state).toBe("failed");
    expect(classify({ status: "queued" })).toEqual({ state: "sent", detail: "queued" });
    expect(classify({ status: "https://evil/<x>" }).detail).not.toMatch(/[:/<>]/);
  });
});

describe("TncSink", () => {
  it("POSTs one URL with auth and idempotency key, then polls statusUrl >= 5 s apart", async () => {
    const { calls, sleeps, sink } = mockApi([
      { status: 202, body: { statusUrl: "/api/v1/submissions/abc" } },
      { status: 200, body: { status: "processing" } },
      { status: 200, body: { status: "completed" } },
    ]);
    const res = await sink.submit(JOB_URL);
    expect(res).toMatchObject({ state: "accepted", detail: "completed", statusUrl: `${BASE}/api/v1/submissions/abc` });
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/submissions`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ url: JOB_URL });
    expect(header(calls[0]!, "authorization")).toBe("Bearer tok-secret");
    expect(header(calls[0]!, "content-type")).toBe("application/json");
    expect(header(calls[0]!, "idempotency-key")).toBe(await idempotencyKey(JOB_URL));
    expect(header(calls[1]!, "authorization")).toBe("Bearer tok-secret");
    expect(sleeps.every((ms) => ms >= 5000)).toBe(true);
    expect(sleeps).toHaveLength(2);
  });

  it("retries 429/5xx with the same key and honours Retry-After", async () => {
    const { calls, sleeps, sink } = mockApi([
      { status: 429, headers: { "retry-after": "7" } },
      { status: 503 },
      { status: 202, body: { statusUrl: `${BASE}/s/1` }, headers: { "retry-after": "9" } },
      { status: 200, body: { status: "queued" }, headers: { "retry-after": "12" } },
      { status: 200, body: { status: "accepted" } },
    ]);
    expect((await sink.submit(JOB_URL)).state).toBe("accepted");
    const keys = calls.slice(0, 3).map((c) => header(c, "idempotency-key"));
    expect(new Set(keys).size).toBe(1);
    expect(sleeps[0]).toBe(7000);
    expect(sleeps[2]).toBe(9000);
    expect(sleeps[3]).toBe(12000);
  });

  it("never sends the token to a statusUrl on another origin", async () => {
    const { calls, sink } = mockApi([{ status: 202, body: { statusUrl: "https://evil.example/steal" } }]);
    const res = await sink.submit(JOB_URL);
    expect(res.state).toBe("sent");
    expect(calls).toHaveLength(1);
  });

  it("fails cleanly on auth errors, bad URLs and repeated network errors", async () => {
    expect(await mockApi([{ status: 401, body: { error: "bad token" } }]).sink.submit(JOB_URL)).toMatchObject({ state: "failed", detail: "http-401" });
    expect((await mockApi([]).sink.submit("javascript:alert(1)")).detail).toBe("invalid-url");
    const net = mockApi([new TypeError("x"), new TypeError("x"), new TypeError("x"), new TypeError("x")]);
    expect((await net.sink.submit(JOB_URL)).detail).toBe("network");
  });

  it("reports failed processing and leaves long-running ones as sent", async () => {
    const failed = mockApi([{ status: 202, body: { statusUrl: "/s/1" } }, { status: 200, body: { status: "rejected" } }]);
    expect((await failed.sink.submit(JOB_URL)).state).toBe("failed");
    const slow = mockApi([{ status: 202, body: { statusUrl: "/s/1" } }, ...Array.from({ length: 4 }, () => ({ status: 200, body: { status: "queued" } }))]);
    expect(await slow.sink.submit(JOB_URL)).toMatchObject({ state: "sent", statusUrl: `${BASE}/s/1` });
  });

  it("requires a token", () => {
    expect(() => new TncSink({ token: "" })).toThrow(/TNC_API_TOKEN/);
  });
});

describe("submitJobs", () => {
  it("sends selected jobs sequentially, paced, skipping accepted and unknown ids, without logging URLs", async () => {
    const logs: string[] = [];
    vi.stubEnv("FITTO_LOG_IN_TESTS", "1");
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
    const s = stateWith("a1", "b2", "c3");
    s.submissions.c3 = { state: "accepted", detail: "completed", key: "k", at: "t", updatedAt: "t", attempts: 1 };
    const { calls, sleeps, sink } = mockApi([
      { status: 202, body: { statusUrl: "/s/a" } },
      { status: 200, body: { status: "completed" } },
      { status: 400, body: { error: "unsupported" } },
    ]);
    const stats = await submitJobs(s, ["a1", "b2", "c3", "ffff00"], sink, { sleep: async (ms) => void sleeps.push(ms), gapMs: 3000 });
    expect(stats).toMatchObject({ requested: 4, accepted: 1, failed: 1, skipped: 1, unknown: 1 });
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(2);
    expect(sleeps).toContain(3000);
    expect(s.submissions.a1).toMatchObject({ state: "accepted", key: await idempotencyKey(`${JOB_URL}?j=a1`), attempts: 1 });
    expect(s.submissions.b2).toMatchObject({ state: "failed", detail: "http-400" });
    const all = logs.join("\n");
    expect(all).toContain("tnc: job 1/4: accepted");
    expect(all).not.toContain(JOB_URL);
    expect(all).not.toContain("tok-secret");
    expect(all).not.toContain("/s/a");
  });

  it("re-checks in-progress submissions instead of posting again, and refreshes pending ones", async () => {
    const s = stateWith("a1");
    s.submissions.a1 = { state: "sent", detail: "queued", key: "k", statusUrl: `${BASE}/s/a`, at: "t", updatedAt: "t", attempts: 1 };
    const { calls, sink } = mockApi([{ status: 200, body: { status: "queued" } }, { status: 200, body: { status: "completed" } }]);
    await submitJobs(s, ["a1"], sink);
    expect(calls[0]!.init?.method).toBeUndefined();
    expect(s.submissions.a1).toMatchObject({ state: "sent", attempts: 2, statusUrl: `${BASE}/s/a` });
    expect(await refreshPending(s, sink)).toBe(1);
    expect(s.submissions.a1!.state).toBe("accepted");
  });

  it("caps batch size and dry-run records nothing", async () => {
    const s = stateWith("a1");
    await expect(submitJobs(s, Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(6, "0")), new DryRunTncSink())).rejects.toThrow(/at most/);
    const dry = new DryRunTncSink();
    await submitJobs(s, ["a1"], dry, { record: false });
    expect(dry.submitted).toBe(1);
    expect(s.submissions).toEqual({});
  });

  it("merges submissions by latest update", () => {
    const a = stateWith("a1");
    const b = stateWith("a1");
    a.submissions.a1 = { state: "sent", detail: "q", key: "k", at: "1", updatedAt: "2026-01-01T00:00:00Z", attempts: 1 };
    b.submissions.a1 = { state: "accepted", detail: "c", key: "k", at: "1", updatedAt: "2026-01-02T00:00:00Z", attempts: 2 };
    expect(mergeStates(a, b).submissions.a1!.state).toBe("accepted");
    expect(mergeStates(b, a).submissions.a1!.state).toBe("accepted");
  });
});
