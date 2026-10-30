import { createHash, createHmac } from "node:crypto";
import type { Job, RawJob, Salary } from "./types.js";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  bull: "•",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Convert (possibly entity-encoded) HTML to compact plain text. */
export function htmlToText(html: string | undefined | null, maxLen = 6000): string {
  if (!html) return "";
  let s = html;
  // Greenhouse double-encodes HTML; decode once if it looks encoded.
  if (/&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

export function isRemote(...texts: (string | undefined | null)[]): boolean {
  return texts.some((t) => !!t && /\b(remote|anywhere|distributed|work from home|wfh)\b/i.test(t));
}

const CURRENCY_SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

/** Best-effort salary extraction from free text like "$120k – $150k" or "120,000-150,000 USD". */
export function parseSalary(text: string | undefined | null): Salary | undefined {
  if (!text) return undefined;
  const re =
    /(?<cur1>[$€£]|USD|EUR|GBP|KES|CAD|AUD|AED|NOK)?\s?(?<a>\d{2,3}(?:[,.]\d{3})*|\d+(?:\.\d+)?)\s?(?<ka>[kK])?\s?(?:-|–|—|to)\s?(?<cur2>[$€£]|USD|EUR|GBP|KES|CAD|AUD|AED|NOK)?\s?(?<b>\d{2,3}(?:[,.]\d{3})*|\d+(?:\.\d+)?)\s?(?<kb>[kK])?\s?(?<cur3>USD|EUR|GBP|KES|CAD|AUD|AED|NOK)?/;
  const m = re.exec(text);
  if (!m?.groups) return undefined;
  const g = m.groups;
  const cur = g.cur1 ?? g.cur2 ?? g.cur3;
  if (!cur) return undefined;
  const num = (v: string, k?: string) => {
    const n = Number(v.replace(/[,.](?=\d{3}\b)/g, ""));
    return k ? n * 1000 : n;
  };
  let min = num(g.a!, g.ka ?? g.kb);
  let max = num(g.b!, g.kb);
  if (min > max) [min, max] = [max, min];
  if (max < 1000) return undefined; // probably not an annual salary
  return { min, max, currency: CURRENCY_SYMBOLS[cur] ?? cur.toUpperCase(), period: "year" };
}

export function annualize(s: Salary): Salary {
  const mult = s.period === "hour" ? 2080 : s.period === "month" ? 12 : 1;
  return {
    ...s,
    min: s.min !== undefined ? s.min * mult : undefined,
    max: s.max !== undefined ? s.max * mult : undefined,
    period: "year",
  };
}

/**
 * Opaque job id. When a secret is provided the id is a keyed HMAC, so ids that
 * appear in public places (workflow_dispatch inputs) cannot be linked back to postings.
 */
export function jobId(source: string, sourceId: string, secret?: string): string {
  const input = `${source}:${sourceId}`;
  const h = secret ? createHmac("sha256", secret).update(input) : createHash("sha256").update(input);
  return h.digest("hex").slice(0, 10);
}

export function normKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(inc|ltd|llc|gmbh|plc|co|corp|corporation|limited)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function finalize(raw: RawJob, secret?: string): Job {
  return {
    ...raw,
    id: jobId(raw.source, raw.sourceId, secret),
    title: raw.title.trim(),
    company: raw.company.trim(),
    location: raw.location.trim() || (raw.remote ? "Remote" : "Unspecified"),
    description: raw.description.slice(0, 6000),
    tags: [...new Set(raw.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))],
  };
}

/** Source priority for dedupe: first-party ATS feeds beat aggregators. */
const SOURCE_PRIORITY = ["greenhouse", "lever", "ashby", "workable", "remotive", "remoteok", "weworkremotely", "hn"];

export function dedupe(jobs: Job[]): Job[] {
  const best = new Map<string, Job>();
  const rank = (j: Job) => {
    const i = SOURCE_PRIORITY.indexOf(j.source);
    return i === -1 ? SOURCE_PRIORITY.length : i;
  };
  for (const j of jobs) {
    const key = `${normKey(j.company)}|${normKey(j.title)}`;
    const prev = best.get(key);
    if (!prev || rank(j) < rank(prev) || (rank(j) === rank(prev) && !prev.salary && j.salary)) {
      best.set(key, j);
    }
  }
  return [...best.values()];
}

export function isFresh(job: Job, maxAgeDays: number, now = Date.now()): boolean {
  if (!job.postedAt) return true;
  const t = Date.parse(job.postedAt);
  if (!Number.isFinite(t)) return true;
  return now - t <= maxAgeDays * 86_400_000;
}
