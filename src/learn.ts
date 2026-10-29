import { normKey } from "./normalize.js";
import type { FewShot } from "./score.js";
import type { JobRecord, Learned, ScoreResult, State } from "./state.js";
import type { Job } from "./types.js";

/**
 * Feedback learning. Thumbs and statuses become signals; each job contributes its
 * features (company, title words, matched skills). A feature's learned weight is the
 * smoothed average signal, in score points. Every weight is visible and editable via
 * `pnpm fitto learned`, and manual weights override learned ones.
 */

export const MAX_FEATURE = 8;
export const MAX_TOTAL = 15;
const SMOOTHING = 2;
const SCALE = 10;

const STOP = new Set(["and", "or", "the", "of", "for", "to", "in", "at", "a", "an", "with", "remote", "m", "f", "d", "w", "x", "senior", "sr", "jr"]);

const SIGNAL: Record<string, number> = { up: 1, down: -1, saved: 0.5, applied: 1, interview: 1, offer: 1, no: -1 };

export function signalOf(r: JobRecord): number {
  const fb = r.feedback ? SIGNAL[r.feedback]! : 0;
  const st = SIGNAL[r.status] ?? 0;
  // Explicit thumbs win over a weaker status signal in the same direction.
  return Math.max(-1.5, Math.min(1.5, fb !== 0 ? fb + st / 2 : st));
}

export function featuresOf(job: Job, result?: Pick<ScoreResult, "matched_skills">): string[] {
  const out = new Set<string>();
  const company = normKey(job.company);
  if (company) out.add(`company:${company}`);
  for (const w of job.title.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    if (w.length > 1 && !STOP.has(w)) out.add(`title:${w}`);
  }
  for (const s of result?.matched_skills ?? []) {
    const k = s.toLowerCase().trim();
    if (k) out.add(`skill:${k}`);
  }
  return [...out];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Recompute automatic weights from every job with a signal. Pure; does not touch updatedAt. */
export function learnWeights(state: State): Record<string, number> {
  const sum = new Map<string, number>();
  const count = new Map<string, number>();
  for (const r of Object.values(state.jobs)) {
    const sig = signalOf(r);
    if (!sig) continue;
    for (const f of featuresOf(r.job, r.score)) {
      sum.set(f, (sum.get(f) ?? 0) + sig);
      count.set(f, (count.get(f) ?? 0) + 1);
    }
  }
  const out: Record<string, number> = {};
  for (const [f, s] of sum) {
    const w = round1(Math.max(-MAX_FEATURE, Math.min(MAX_FEATURE, (s / (count.get(f)! + SMOOTHING)) * SCALE)));
    if (Math.abs(w) >= 0.5) out[f] = w;
  }
  return out;
}

export function effectiveWeights(l: Learned): Record<string, number> {
  return { ...l.auto, ...l.manual };
}

export interface Adjustment {
  points: number;
  reasons: string[];
}

export function adjustmentFor(l: Learned, job: Job, result: ScoreResult): Adjustment {
  const w = effectiveWeights(l);
  const hits = featuresOf(job, result)
    .filter((f) => w[f])
    .map((f) => ({ f, v: w[f]! }))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const total = hits.reduce((s, h) => s + h.v, 0);
  return {
    points: Math.round(Math.max(-MAX_TOTAL, Math.min(MAX_TOTAL, total))),
    reasons: hits.slice(0, 4).map((h) => `${h.f} ${h.v > 0 ? "+" : ""}${h.v}`),
  };
}

/** Recent reactions as few-shot examples for the LLM prompt (balanced liked/disliked). */
export function fewShotExamples(state: State, n = 6): FewShot[] {
  const signalled = Object.values(state.jobs)
    .filter((r) => signalOf(r) !== 0)
    .sort((a, b) => (b.feedbackAt ?? b.statusUpdatedAt ?? "").localeCompare(a.feedbackAt ?? a.statusUpdatedAt ?? ""));
  const toShot = (r: JobRecord): FewShot => ({
    title: r.job.title,
    company: r.job.company,
    verdict: signalOf(r) > 0 ? "liked" : "disliked",
    note: [r.feedback === "up" ? "thumbs up" : r.feedback === "down" ? "thumbs down" : "", r.status !== "new" ? r.status : ""]
      .filter(Boolean)
      .join(", "),
  });
  const liked = signalled.filter((r) => signalOf(r) > 0).slice(0, Math.ceil(n / 2));
  const disliked = signalled.filter((r) => signalOf(r) < 0).slice(0, n - liked.length);
  return [...liked, ...disliked].map(toShot);
}

export function renderLearned(l: Learned, examples: FewShot[]): string {
  const keys = [...new Set([...Object.keys(l.auto), ...Object.keys(l.manual)])].sort(
    (a, b) => Math.abs(effectiveWeights(l)[b]!) - Math.abs(effectiveWeights(l)[a]!),
  );
  const lines = ["feature".padEnd(36) + "auto    manual  effective"];
  for (const k of keys) {
    const a = l.auto[k];
    const m = l.manual[k];
    lines.push(`${k.slice(0, 35).padEnd(36)}${(a ?? "").toString().padEnd(8)}${(m ?? "").toString().padEnd(8)}${m ?? a}`);
  }
  if (!keys.length) lines.push("(no learned weights yet: mark jobs with up/down or statuses)");
  lines.push("", `Per-feature cap ±${MAX_FEATURE}, total adjustment cap ±${MAX_TOTAL} points.`, "", "Few-shot examples sent to the scorer:");
  lines.push(...(examples.length ? examples.map((e) => `- ${e.verdict}: ${e.title} @ ${e.company}${e.note ? ` (${e.note})` : ""}`) : ["(none yet)"]));
  return lines.join("\n");
}

export const FEATURE_RE = /^(company|title|skill):[a-z0-9+#. -]{1,60}$/;
