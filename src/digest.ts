import type { Profile } from "./config.js";
import { devprepLink } from "./devprep.js";
import type { Message } from "./sinks/types.js";
import type { JobRecord, State, Status } from "./state.js";
import type { Job } from "./types.js";

const CLOSED: Status[] = ["no", "rejected"];

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const where = (j: Job): string => (j.remote && !/remote/i.test(j.location) ? ` · remote` : j.location);
export const safeUrl = (u: string): string => (/^https?:\/\//i.test(u) ? u : "#");

export function formatSalary(job: Job): string {
  const s = job.salary;
  if (!s || (!s.min && !s.max)) return "not listed";
  const n = (v?: number) => (v ? (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)) : "?");
  const range = s.min && s.max && s.min !== s.max ? `${n(s.min)}–${n(s.max)}` : n(s.min ?? s.max);
  return `${s.currency ?? ""} ${range}${s.period && s.period !== "year" ? `/${s.period}` : ""}`.trim();
}

/**
 * Jobs for today's digest: scored at or above the threshold, not closed, and either
 * never sent or whose status changed since they were last sent. Best first, top N.
 */
export function selectDigest(state: State, profile: Profile): JobRecord[] {
  return Object.values(state.jobs)
    .filter((r) => r.score && r.score.final >= profile.digest.min_score && !CLOSED.includes(r.status))
    .filter((r) => !r.digestedAt || r.digestedStatus !== r.status)
    .sort((a, b) => b.score!.final - a.score!.final)
    .slice(0, profile.digest.top_n);
}

export function markDigested(records: JobRecord[], now: Date): void {
  for (const r of records) {
    r.digestedAt = now.toISOString();
    r.digestedStatus = r.status;
  }
}

export interface Links {
  repo: string;
  site?: string;
}

const statusWorkflow = (repo: string) => `https://github.com/${repo}/actions/workflows/fitto-status.yml`;
export const statusCommand = (repo: string, id: string, status: string): string =>
  `gh workflow run fitto-status.yml -R ${repo} -f ids=${id} -f status=${status}`;

function jobText(r: JobRecord, i: number, state: State, links: Links): string {
  const { job, score } = r;
  const s = score!;
  const lines = [
    `${i + 1}. ${job.title} — ${job.company}  [${s.final}/100]${r.status !== "new" ? ` (${r.status})` : ""}`,
    `   ${where(job)} · salary: ${formatSalary(job)}`,
    `   Why: ${s.fit_summary}`,
  ];
  if (s.matched_skills.length) lines.push(`   Matched: ${s.matched_skills.join(", ")}`);
  if (s.gaps.length) lines.push(`   Gaps: ${s.gaps.join("; ")}`);
  if (s.red_flags.length) lines.push(`   Red flags: ${s.red_flags.join("; ")}`);
  lines.push(`   Link: ${job.url}${job.attribution ? ` (via ${job.attribution})` : ""}`);
  const prep = devprepLink(job.company);
  if (prep) lines.push(`   Interview prep: ${prep}`);
  const d = state.drafts[job.id];
  if (d) {
    lines.push(`   DRAFT CV bullets (review before use; nothing is sent to employers):`);
    for (const b of d.cv_bullets) lines.push(`     - ${b}`);
    lines.push(`   DRAFT cover note: ${d.cover_note}`);
  }
  lines.push(`   Id ${job.id}: ${statusCommand(links.repo, job.id, "saved")}  (or applied / no / up / down)`);
  return lines.join("\n");
}

function jobHtml(r: JobRecord, state: State, links: Links): string {
  const { job, score } = r;
  const s = score!;
  const list = (label: string, xs: string[]) =>
    xs.length ? `<div><b>${label}:</b> ${xs.map(esc).join(", ")}</div>` : "";
  const prep = devprepLink(job.company);
  const d = state.drafts[job.id];
  const draft = d
    ? `<details style="margin-top:6px"><summary><b>DRAFT</b> CV bullets &amp; cover note (review before use; never sent to employers)</summary>
<ul>${d.cv_bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul><p style="white-space:pre-wrap">${esc(d.cover_note)}</p></details>`
    : "";
  const cmd = (st: string) => `<code style="font-size:11px">${esc(statusCommand(links.repo, job.id, st))}</code>`;
  return `<tr><td style="padding:12px 0;border-bottom:1px solid #eee">
<div style="font-size:16px"><a href="${esc(safeUrl(job.url))}"><b>${esc(job.title)}</b></a> — ${esc(job.company)}
<span style="float:right;font-weight:bold">${s.final}/100</span></div>
<div style="color:#555">${esc(where(job))} · salary: ${esc(formatSalary(job))}${r.status !== "new" ? ` · <i>${esc(r.status)}</i>` : ""}${job.attribution ? ` · via ${esc(job.attribution)}` : ""}</div>
<div style="margin-top:4px">${esc(s.fit_summary)}</div>
${list("Matched", s.matched_skills)}${list("Gaps", s.gaps)}${list("Red flags", s.red_flags)}
${prep ? `<div><a href="${esc(prep)}">Interview prep on DevPREP</a></div>` : ""}${draft}
<div style="margin-top:6px;color:#555">Id <code>${esc(job.id)}</code>. Mark it: ${cmd("saved")} · <code>applied</code> · <code>no</code> · <code>up</code> · <code>down</code>
(or use <a href="${esc(statusWorkflow(links.repo))}">Run workflow</a> on the Actions page)</div>
</td></tr>`;
}

export function renderDigest(records: JobRecord[], state: State, links: Links, now = new Date()): Message {
  const date = now.toISOString().slice(0, 10);
  const subject = records.length ? `Fitto: ${records.length} job matches for ${date}` : `Fitto: no new matches for ${date}`;
  const footer = `Statuses: run the gh command, or open ${statusWorkflow(links.repo)} → Run workflow with the job id.${
    links.site ? ` Encrypted list: ${links.site}` : ""
  }`;
  const text = [subject, ...records.map((r, i) => jobText(r, i, state, links)), "", footer].join("\n\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:720px;margin:auto">
<h2>${esc(subject)}</h2><table style="width:100%;border-collapse:collapse">${records.map((r) => jobHtml(r, state, links)).join("")}</table>
<p style="color:#777;font-size:12px">${esc(footer)} Scores are AI estimates; drafts are drafts. Fitto never applies or contacts employers for you.</p></body></html>`;
  return {
    kind: "daily",
    subject,
    text,
    html,
    count: records.length,
    redacted: `### Fitto daily digest (redacted)\n\n${records.length} matches would be sent. Job details are never written to public logs.`,
  };
}
