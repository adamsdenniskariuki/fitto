import type { Profile } from "./config.js";
import { annualize } from "./normalize.js";
import type { Job } from "./types.js";

export interface FilterResult {
  pass: boolean;
  reason?: string;
}

const LEVELS: { level: string; re: RegExp }[] = [
  { level: "intern", re: /\b(intern|internship|apprentice)\b/i },
  { level: "junior", re: /\b(junior|jr\.?|entry[- ]level|graduate|associate)\b/i },
  { level: "mid", re: /\b(mid[- ]level|intermediate)\b|\b(engineer|developer) (i|ii)\b/i },
  { level: "senior", re: /\b(senior|sr\.?)\b|\b(engineer|developer) iii\b/i },
  { level: "staff", re: /\bstaff\b/i },
  { level: "principal", re: /\b(principal|distinguished)\b/i },
  { level: "lead", re: /\b(lead|tech lead)\b/i },
  { level: "manager", re: /\b(manager|head of|director|vp)\b/i },
];

export function detectSeniority(title: string): string[] {
  return LEVELS.filter((l) => l.re.test(title)).map((l) => l.level);
}

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

/** Annual floor for a salary in `currency`: the matching `floors` entry, else `min` when the currency matches or is unknown. */
export function salaryFloor(profile: Profile, currency?: string): number | undefined {
  const sal = profile.salary;
  if (!sal) return undefined;
  const code = currency?.toUpperCase();
  if (code) {
    const extra = Object.entries(sal.floors ?? {}).find(([c]) => c.toUpperCase() === code);
    if (extra) return extra[1];
    return code === sal.currency.toUpperCase() ? sal.min : undefined;
  }
  return sal.min;
}

/** Cheap deterministic filters applied before any LLM call. */
export function hardFilter(job: Job, profile: Profile): FilterResult {
  const title = job.title;
  if (profile.title_keywords.length && !profile.title_keywords.some((k) => has(title, k))) {
    return { pass: false, reason: "title" };
  }
  if (profile.exclude_title_keywords.some((k) => has(title, k))) return { pass: false, reason: "title-excluded" };

  if (profile.seniority.length) {
    const levels = detectSeniority(title);
    const wanted = profile.seniority.map((s) => s.toLowerCase());
    if (levels.length && !levels.some((l) => wanted.includes(l))) return { pass: false, reason: "seniority" };
  }

  const loc = profile.locations;
  const where = `${job.location} ${job.title}`;
  if (loc.exclude.some((x) => has(where, x) || has(job.description.slice(0, 1500), x))) {
    return { pass: false, reason: "location-restricted" };
  }
  if (job.remote) {
    if (!loc.remote) {
      const local = [...loc.onsite_cities, ...loc.countries].some((c) => has(job.location, c));
      if (!local) return { pass: false, reason: "remote-not-wanted" };
    }
  } else {
    const places = [...loc.onsite_cities, ...loc.countries];
    if (!places.some((c) => has(job.location, c))) return { pass: false, reason: "location" };
  }

  if (job.salary) {
    const s = annualize(job.salary);
    const top = s.max ?? s.min;
    const floor = salaryFloor(profile, s.currency);
    if (floor && top !== undefined && top < floor) return { pass: false, reason: "salary" };
  }

  const text = `${job.title}\n${job.company}\n${job.description}`;
  if (profile.dealbreakers.some((d) => has(text, d))) return { pass: false, reason: "dealbreaker" };

  return { pass: true };
}
