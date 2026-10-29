import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileSchema } from "../src/config.js";
import { devprepLink } from "../src/devprep.js";
import { markDigested, renderDigest, selectDigest } from "../src/digest.js";
import { finalize } from "../src/normalize.js";
import { deliver, sinksFromEnv, type Message, type Sink } from "../src/sinks/index.js";
import { DryRunSink } from "../src/sinks/dryrun.js";
import { emailSinkFromEnv, ResendSink } from "../src/sinks/email.js";
import { emptyState, type JobRecord, type State } from "../src/state.js";
import { applyStatus, parseIds } from "../src/status.js";
import { renderTracker } from "../src/tracker.js";
import { renderWeekly, weeklyData } from "../src/weekly.js";

const profile = ProfileSchema.parse({ digest: { min_score: 60, top_n: 2 } });
const links = { repo: "o/fitto" };
const NOW = new Date("2026-03-10T05:00:00Z");

function rec(id: string, score: number | undefined, over: Partial<JobRecord> = {}): JobRecord {
  const job = { ...finalize({ source: "t", sourceId: id, company: `Co ${id}`, title: `Engineer <${id}>`, location: "Remote", remote: true, url: `https://x.test/${id}`, description: "", tags: [] }), id };
  return {
    job,
    firstSeen: "2026-03-08T00:00:00Z",
    lastSeen: "2026-03-10T00:00:00Z",
    status: "new",
    history: [],
    score: score === undefined ? undefined : { score, final: score, adjustment: 0, fit_summary: "fits", matched_skills: ["ts"], gaps: ["go"], red_flags: [], confidence: "high", provider: "p", cacheKey: "k", scoredAt: "x" },
    ...over,
  };
}

function state(...rs: JobRecord[]): State {
  const s = emptyState();
  for (const r of rs) s.jobs[r.job.id] = r;
  return s;
}

describe("digest selection", () => {
  it("takes the top N above threshold and does not repeat", () => {
    const s = state(rec("a1", 90), rec("b2", 70), rec("c3", 80), rec("d4", 50), rec("e5", 95, { status: "no" }), rec("f6", undefined));
    const picks = selectDigest(s, profile);
    expect(picks.map((r) => r.job.id)).toEqual(["a1", "c3"]);
    markDigested(picks, NOW);
    expect(selectDigest(s, profile).map((r) => r.job.id)).toEqual(["b2"]);
  });
  it("resends when the status changed", () => {
    const s = state(rec("a1", 90));
    markDigested(selectDigest(s, profile), NOW);
    expect(selectDigest(s, profile)).toEqual([]);
    applyStatus(s, ["a1"], "saved", NOW);
    expect(selectDigest(s, profile)).toHaveLength(1);
  });
});

describe("digest rendering", () => {
  it("escapes HTML, includes actions, drafts and DevPREP links, and redacts the public form", () => {
    const r = rec("a1", 90);
    r.job.company = "Stripe";
    const s = state(r);
    s.drafts.a1 = { cv_bullets: ["Did <b>things</b>"], cover_note: "Hello", createdAt: "x", provider: "p" };
    const m = renderDigest([r], s, links, NOW);
    expect(m.html).toContain("Engineer &lt;a1&gt;");
    expect(m.html).not.toContain("<b>things</b>");
    expect(m.text).toContain("gh workflow run fitto-status.yml -R o/fitto -f ids=a1 -f status=saved");
    expect(m.text).toContain("https://devprep.madebyfavor.com/#company/stripe");
    expect(m.text).toContain("DRAFT");
    expect(m.redacted).not.toContain("Stripe");
    expect(m.redacted).not.toContain("a1");
  });
  it("neutralises non-http links", () => {
    const r = rec("a1", 90);
    r.job.url = "javascript:alert(1)";
    expect(renderDigest([r], state(r), links).html).not.toContain("javascript:");
  });
});

describe("devprep", () => {
  it("maps known companies only", () => {
    expect(devprepLink("Amazon Web Services")).toMatch(/#company\/amazon$/);
    expect(devprepLink("Safaricom PLC")).toMatch(/#company\/safaricom$/);
    expect(devprepLink("Acme")).toBeUndefined();
  });
});

describe("status", () => {
  it("validates ids and values, records feedback separately", () => {
    expect(() => parseIds("abc123,not-an-id!")).toThrow();
    const s = state(rec("abc123", 70));
    expect(() => applyStatus(s, ["abc123"], "maybe")).toThrow();
    expect(applyStatus(s, ["abc123", "fff000"], "up", NOW)).toEqual({ updated: 1, unknown: 1 });
    applyStatus(s, ["abc123"], "applied", NOW);
    expect(s.jobs.abc123).toMatchObject({ status: "applied", feedback: "up" });
    expect(s.jobs.abc123!.history).toHaveLength(2);
  });
});

describe("weekly and tracker", () => {
  it("summarises the week", () => {
    const s = state(rec("a1", 90, { status: "applied", statusUpdatedAt: "2026-03-09T00:00:00Z" }), rec("b2", 40), rec("c3", 70, { firstSeen: "2026-01-01T00:00:00Z" }));
    s.runs.push({ at: "2026-03-09T05:00:00Z", kind: "daily" }, { at: "2026-02-01T05:00:00Z", kind: "daily" });
    const d = weeklyData(s, 60, NOW);
    expect(d).toMatchObject({ newJobs: 2, scored: 2, matches: 1, runs: 1 });
    expect(d.pipeline.applied).toBe(1);
    const m = renderWeekly(d, links, NOW);
    expect(m.subject).toBe("Fitto weekly: 1 matches, 1 applied");
    expect(m.redacted).not.toContain("Co a1");
  });
  it("prints tracked jobs first", () => {
    const out = renderTracker(state(rec("a1", 90), rec("b2", 40, { status: "applied" }), rec("c3", 10)));
    const lines = out.split("\n");
    expect(lines[2]).toContain("applied");
    expect(out).not.toContain("c3");
  });
});

describe("sinks", () => {
  const msg: Message = { kind: "daily", subject: "s", text: "t", html: "h", count: 1, redacted: "R" };
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("picks email providers from env and falls back to dry run", () => {
    expect(emailSinkFromEnv({ RESEND_API_KEY: "k" })).toBeUndefined();
    expect(emailSinkFromEnv({ RESEND_API_KEY: "k", FITTO_EMAIL_TO: "a@b" })?.name).toBe("email (resend)");
    expect(emailSinkFromEnv({ SMTP_HOST: "h", FITTO_EMAIL_TO: "a@b" })?.name).toBe("email (smtp)");
    expect(sinksFromEnv({}, false).map((s) => s.name)).toEqual(["dry-run"]);
    expect(sinksFromEnv({ SMTP_HOST: "h", FITTO_EMAIL_TO: "a@b" }, true).map((s) => s.name)).toEqual(["dry-run"]);
  });

  it("dry run writes only the redacted form to the job summary", async () => {
    const d = mkdtempSync(join(tmpdir(), "fitto-"));
    dirs.push(d);
    const summary = join(d, "summary.md");
    await new DryRunSink({ GITHUB_STEP_SUMMARY: summary }, join(d, "out")).send(msg);
    expect(readFileSync(summary, "utf8")).toBe("R\n");
    await new DryRunSink({}, join(d, "out")).send(msg);
    expect(readFileSync(join(d, "out", "daily.html"), "utf8")).toBe("h");
  });

  it("posts to Resend and reports failures by status only", async () => {
    let body: Record<string, unknown> = {};
    const ok = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await new ResendSink({ RESEND_API_KEY: "k", FITTO_EMAIL_TO: "me@x" }, ok).send(msg);
    expect(body).toMatchObject({ to: ["me@x"], subject: "s", html: "h" });
    const bad = (async () => new Response("me@x invalid", { status: 422 })) as typeof fetch;
    await expect(new ResendSink({ RESEND_API_KEY: "k", FITTO_EMAIL_TO: "me@x" }, bad).send(msg)).rejects.toThrow(/^Resend returned HTTP 422$/);
  });

  it("deliver succeeds if any sink succeeds", async () => {
    const good: Sink = { name: "g", send: async () => {} };
    const broken: Sink = { name: "b", send: async () => { throw new Error("x"); } };
    expect(await deliver([broken, good], msg)).toBe(true);
    expect(await deliver([broken], msg)).toBe(false);
  });
});
