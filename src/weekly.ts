import { esc, formatSalary, safeUrl, type Links } from "./digest.js";
import type { Context } from "./context.js";
import { log } from "./log.js";
import { deliver } from "./sinks/index.js";
import { saveState, type JobRecord, type State, type Status } from "./state.js";
import type { Message } from "./sinks/types.js";

const WEEK = 7 * 86_400_000;
const PIPELINE: Status[] = ["saved", "applied", "interview", "offer", "rejected"];

export interface WeeklyData {
  newJobs: number;
  scored: number;
  matches: number;
  runs: number;
  pipeline: Record<string, number>;
  movedThisWeek: JobRecord[];
  top: JobRecord[];
}

export function weeklyData(state: State, minScore: number, now = new Date()): WeeklyData {
  const since = now.getTime() - WEEK;
  const inWeek = (t?: string) => !!t && Date.parse(t) >= since;
  const all = Object.values(state.jobs);
  const runs = state.runs.filter((r) => r.kind === "daily" && inWeek(r.at));
  const fresh = all.filter((r) => inWeek(r.firstSeen));
  const pipeline: Record<string, number> = {};
  for (const s of PIPELINE) pipeline[s] = all.filter((r) => r.status === s).length;
  return {
    newJobs: fresh.length,
    scored: fresh.filter((r) => r.score).length,
    matches: fresh.filter((r) => (r.score?.final ?? 0) >= minScore).length,
    runs: runs.length,
    pipeline,
    movedThisWeek: all.filter((r) => r.status !== "new" && inWeek(r.statusUpdatedAt)),
    top: fresh
      .filter((r) => r.score && r.status !== "no")
      .sort((a, b) => b.score!.final - a.score!.final)
      .slice(0, 5),
  };
}

export function renderWeekly(d: WeeklyData, links: Links, now = new Date()): Message {
  const subject = `Fitto weekly: ${d.matches} matches, ${d.pipeline.applied ?? 0} applied`;
  const pipe = Object.entries(d.pipeline)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  const row = (r: JobRecord) => `${r.job.title} — ${r.job.company} [${r.score?.final ?? "–"}] ${r.job.url}`;
  const text = [
    `${subject} (week to ${now.toISOString().slice(0, 10)})`,
    `${d.runs} daily runs · ${d.newJobs} new jobs passed filters · ${d.scored} scored · ${d.matches} matches`,
    `Pipeline: ${pipe}`,
    d.movedThisWeek.length ? `Status changes this week:\n${d.movedThisWeek.map((r) => `- ${r.status}: ${row(r)}`).join("\n")}` : "",
    d.top.length ? `Best new jobs this week:\n${d.top.map((r) => `- ${row(r)} · ${formatSalary(r.job)}`).join("\n")}` : "",
    `Repo: https://github.com/${links.repo}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const li = (r: JobRecord, extra = "") =>
    `<li><a href="${esc(safeUrl(r.job.url))}">${esc(r.job.title)}</a> — ${esc(r.job.company)} <b>${r.score?.final ?? "–"}</b>${extra}</li>`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:720px;margin:auto">
<h2>${esc(subject)}</h2>
<p>${d.runs} daily runs · ${d.newJobs} new jobs passed filters · ${d.scored} scored · ${d.matches} matches</p>
<p><b>Pipeline:</b> ${esc(pipe)}</p>
${d.movedThisWeek.length ? `<h3>Status changes this week</h3><ul>${d.movedThisWeek.map((r) => li(r, ` · <i>${esc(r.status)}</i>`)).join("")}</ul>` : ""}
${d.top.length ? `<h3>Best new jobs this week</h3><ul>${d.top.map((r) => li(r)).join("")}</ul>` : ""}
</body></html>`;
  return {
    kind: "weekly",
    subject,
    text,
    html,
    count: d.top.length,
    redacted: `### Fitto weekly summary (redacted)\n\n${d.runs} daily runs this week. Details are only sent by email.`,
  };
}

/** Weekly summary; skipped if one was sent in the last 6 days unless forced. */
export async function runWeekly(ctx: Context, force = false, now = new Date()): Promise<boolean> {
  const { state, version } = await ctx.store.load();
  if (!force && state.weeklySentAt && now.getTime() - Date.parse(state.weeklySentAt) < 6 * 86_400_000) {
    log.info("weekly: already sent this week");
    return false;
  }
  const ok = await deliver(ctx.sinks, renderWeekly(weeklyData(state, ctx.profile.digest.min_score, now), ctx.links, now));
  if (ok) {
    state.weeklySentAt = now.toISOString();
    state.runs.push({ at: now.toISOString(), kind: "weekly" });
    await saveState(ctx.store, state, version);
  }
  return ok;
}
