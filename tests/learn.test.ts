import { describe, expect, it } from "vitest";
import { adjustmentFor, featuresOf, fewShotExamples, learnWeights, MAX_TOTAL, renderLearned, signalOf } from "../src/learn.js";
import { finalize } from "../src/normalize.js";
import { emptyState, type JobRecord, type State } from "../src/state.js";

const score = (skills: string[]) => ({ score: 70, fit_summary: "", matched_skills: skills, gaps: [], red_flags: [], confidence: "high" as const });

function rec(id: string, company: string, title: string, over: Partial<JobRecord> = {}): JobRecord {
  const job = { ...finalize({ source: "t", sourceId: id, company, title, location: "Remote", remote: true, url: "u", description: "", tags: [] }), id };
  return {
    job,
    firstSeen: "x",
    lastSeen: "x",
    status: "new",
    history: [],
    score: { ...score(["go"]), final: 70, adjustment: 0, provider: "p", cacheKey: "k", scoredAt: "x" },
    ...over,
  };
}
const st = (...rs: JobRecord[]): State => {
  const s = emptyState();
  for (const r of rs) s.jobs[r.job.id] = r;
  return s;
};

describe("feedback learning", () => {
  it("derives signals from thumbs and statuses", () => {
    expect(signalOf(rec("a", "A", "T", { feedback: "up" }))).toBe(1);
    expect(signalOf(rec("a", "A", "T", { status: "applied" }))).toBe(1);
    expect(signalOf(rec("a", "A", "T", { status: "no", feedback: "down" }))).toBe(-1.5);
    expect(signalOf(rec("a", "A", "T", { status: "rejected" }))).toBe(0);
  });

  it("extracts company, title and skill features", () => {
    expect(featuresOf(rec("a", "Acme Inc", "Senior Backend Engineer").job, score(["Go"]))).toEqual(
      expect.arrayContaining(["company:acme", "title:backend", "title:engineer", "skill:go"]),
    );
  });

  it("learns boosts and penalties and applies them with caps and reasons", () => {
    const s = st(
      rec("a", "Acme", "Backend Engineer", { feedback: "up" }),
      rec("b", "Acme", "Platform Engineer", { status: "applied" }),
      rec("c", "Gamblr", "Frontend Engineer", { status: "no", feedback: "down" }),
    );
    s.learned.auto = learnWeights(s);
    expect(s.learned.auto["company:acme"]).toBeGreaterThan(0);
    expect(s.learned.auto["company:gamblr"]).toBeLessThan(0);
    const fresh = rec("d", "Acme", "Backend Developer").job;
    const adj = adjustmentFor(s.learned, fresh, score([]));
    expect(adj.points).toBeGreaterThan(0);
    expect(adj.reasons.join(" ")).toContain("company:acme");

    s.learned.manual["company:acme"] = -8;
    expect(adjustmentFor(s.learned, fresh, score([])).points).toBeLessThan(0);
    s.learned.manual = { "title:backend": 100, "company:acme": 100 };
    expect(adjustmentFor(s.learned, fresh, score([])).points).toBe(MAX_TOTAL);
  });

  it("builds balanced few-shot examples and a readable report", () => {
    const s = st(
      rec("a", "Acme", "Backend", { feedback: "up", feedbackAt: "2026-01-02" }),
      rec("c", "Gamblr", "Frontend", { status: "no", statusUpdatedAt: "2026-01-03" }),
      rec("e", "Quiet", "Nothing"),
    );
    const ex = fewShotExamples(s);
    expect(ex.map((e) => e.verdict).sort()).toEqual(["disliked", "liked"]);
    const report = renderLearned({ ...s.learned, auto: learnWeights(s) }, ex);
    expect(report).toContain("company:acme");
    expect(report).toContain("liked: Backend @ Acme (thumbs up)");
  });
});
