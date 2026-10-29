import type { Profile } from "./config.js";
import { hardFilter } from "./filters.js";
import type { State } from "./state.js";
import type { Job } from "./types.js";

export interface IngestStats {
  fetched: number;
  passed: number;
  newJobs: number;
  filtered: Record<string, number>;
}

/** Applies hard filters and upserts passing jobs into state. Returns ids that passed. */
export function ingest(state: State, jobs: Job[], profile: Profile, now = new Date()): { ids: string[]; stats: IngestStats } {
  const at = now.toISOString();
  const stats: IngestStats = { fetched: jobs.length, passed: 0, newJobs: 0, filtered: {} };
  const ids: string[] = [];
  for (const job of jobs) {
    const f = hardFilter(job, profile);
    if (!f.pass) {
      stats.filtered[f.reason ?? "other"] = (stats.filtered[f.reason ?? "other"] ?? 0) + 1;
      continue;
    }
    stats.passed++;
    ids.push(job.id);
    const rec = state.jobs[job.id];
    if (rec) {
      rec.job = job;
      rec.lastSeen = at;
    } else {
      stats.newJobs++;
      state.jobs[job.id] = { job, firstSeen: at, lastSeen: at, status: "new", history: [] };
    }
  }
  return { ids, stats };
}
