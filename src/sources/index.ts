import type { CompaniesConfig } from "../config.js";
import type { HttpClient } from "../http.js";
import { log } from "../log.js";
import { dedupe, finalize, isFresh } from "../normalize.js";
import type { Job, RawJob } from "../types.js";
import { fetchAshby, fetchGreenhouse, fetchLever, fetchWorkable } from "./ats.js";
import { fetchHn, fetchRemoteOk, fetchRemotive, fetchWeWorkRemotely } from "./boards.js";

export interface SourceTask {
  label: string;
  run: () => Promise<RawJob[]>;
}

export function buildTasks(http: HttpClient, cfg: CompaniesConfig): SourceTask[] {
  const tasks: SourceTask[] = [];
  const ats = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby, workable: fetchWorkable };
  for (const c of cfg.companies) {
    tasks.push({ label: `${c.ats}:${c.slug}`, run: () => ats[c.ats](http, c.slug, c.name) });
  }
  const b = cfg.boards;
  if (b.remotive?.enabled) tasks.push({ label: "remotive", run: () => fetchRemotive(http, b.remotive!.category) });
  if (b.weworkremotely?.enabled) {
    for (const f of b.weworkremotely.feeds) {
      tasks.push({ label: `weworkremotely:${f}`, run: () => fetchWeWorkRemotely(http, f) });
    }
  }
  if (b.remoteok?.enabled) tasks.push({ label: "remoteok", run: () => fetchRemoteOk(http) });
  if (b.hn?.enabled) tasks.push({ label: "hn", run: () => fetchHn(http, b.hn!.maxComments) });
  return tasks;
}

export interface FetchResult {
  jobs: Job[];
  stats: { label: string; count: number; error?: string }[];
}

/** Runs all sources (bounded concurrency), normalises, filters stale postings and dedupes. */
export async function fetchAll(
  tasks: SourceTask[],
  opts: { secret?: string; maxAgeDays: number; concurrency?: number },
): Promise<FetchResult> {
  const stats: FetchResult["stats"] = [];
  const all: Job[] = [];
  const queue = [...tasks];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const raw = await t.run();
        const jobs = raw
          .filter((r) => r.title && r.url && r.company)
          .map((r) => finalize(r, opts.secret))
          .filter((j) => isFresh(j, opts.maxAgeDays));
        all.push(...jobs);
        stats.push({ label: t.label, count: jobs.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        stats.push({ label: t.label, count: 0, error: msg });
        log.warn(`source ${t.label} failed: ${msg}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  stats.sort((a, b) => a.label.localeCompare(b.label));
  return { jobs: dedupe(all), stats };
}
