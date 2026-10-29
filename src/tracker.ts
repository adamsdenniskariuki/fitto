import { formatSalary } from "./digest.js";
import type { JobRecord, State } from "./state.js";

/** Plain-text tracker of every job you've acted on, plus the best untouched ones. Local use only. */
export function renderTracker(state: State, opts: { all?: boolean; limit?: number } = {}): string {
  const rows = Object.values(state.jobs)
    .filter((r) => opts.all || r.status !== "new" || r.feedback || (r.score?.final ?? 0) >= 60)
    .sort((a, b) => order(a) - order(b) || (b.score?.final ?? -1) - (a.score?.final ?? -1))
    .slice(0, opts.limit ?? 100);
  if (!rows.length) return "No tracked jobs yet.";
  const head = ["id", "status", "fb", "score", "company", "title", "salary", "updated"];
  const data = rows.map((r) => [
    r.job.id,
    r.status,
    r.feedback === "up" ? "👍" : r.feedback === "down" ? "👎" : "",
    r.score ? String(r.score.final) : "–",
    r.job.company,
    r.job.title,
    formatSalary(r.job),
    (r.statusUpdatedAt ?? r.firstSeen).slice(0, 10),
  ]);
  const widths = head.map((h, i) => Math.min(40, Math.max(h.length, ...data.map((d) => d[i]!.length))));
  const fmt = (cols: string[]) => cols.map((c, i) => c.slice(0, widths[i]).padEnd(widths[i]!)).join("  ");
  return [fmt(head), widths.map((w) => "-".repeat(w)).join("  "), ...data.map(fmt)].join("\n");
}

const RANK: Record<string, number> = { offer: 0, interview: 1, applied: 2, saved: 3, new: 4, rejected: 5, no: 6 };
const order = (r: JobRecord) => RANK[r.status] ?? 9;
