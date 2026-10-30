import { log } from "./log.js";
import { DryRunTncSink, idempotencyKey, TncSink, type SubmissionResult, type SubmissionSink } from "./sinks/tnc.js";
import type { State } from "./state.js";

/** One workflow run handles at most this many selected jobs. */
export const MAX_SUBMIT_IDS = 50;
/** Pause between POSTs so a batch is polite to the API. */
export const SUBMIT_GAP_MS = 3_000;

export interface SubmitStats {
  requested: number;
  accepted: number;
  sent: number;
  failed: number;
  skipped: number;
  unknown: number;
}

export interface SubmitOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  gapMs?: number;
  /** Don't record results (dry run). */
  record?: boolean;
}

export function tncSinkFromEnv(env: NodeJS.ProcessEnv, dryRun: boolean): SubmissionSink {
  if (dryRun) return new DryRunTncSink();
  if (!env.TNC_API_TOKEN) throw new Error("TNC_API_TOKEN is not set; add it with `gh secret set TNC_API_TOKEN` (see SETUP.md)");
  return new TncSink({ token: env.TNC_API_TOKEN, baseUrl: env.TNC_BASE_URL || undefined });
}

async function record(state: State, id: string, url: string, res: SubmissionResult, at: string): Promise<void> {
  const prev = state.submissions[id];
  const key = await idempotencyKey(url);
  state.submissions[id] = {
    state: res.state,
    detail: res.detail,
    key,
    statusUrl: res.statusUrl ?? (res.state === "sent" ? prev?.statusUrl : undefined),
    at: prev?.at ?? at,
    updatedAt: at,
    attempts: (prev?.attempts ?? 0) + 1,
  };
}

/**
 * Send the user's explicitly selected jobs to The Next Chapter, one URL per request, sequentially.
 * Already-accepted jobs are skipped; in-progress ones are re-checked instead of re-posted.
 * Logs only positions and outcomes, never URLs, titles or tokens.
 */
export async function submitJobs(state: State, ids: string[], sink: SubmissionSink, opts: SubmitOptions = {}): Promise<SubmitStats> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = opts.gapMs ?? SUBMIT_GAP_MS;
  const unique = [...new Set(ids)];
  if (unique.length > MAX_SUBMIT_IDS) throw new Error(`select at most ${MAX_SUBMIT_IDS} jobs per send`);
  const stats: SubmitStats = { requested: unique.length, accepted: 0, sent: 0, failed: 0, skipped: 0, unknown: 0 };
  let posted = false;
  for (const [i, id] of unique.entries()) {
    const pos = `${i + 1}/${unique.length}`;
    const r = state.jobs[id];
    if (!r) {
      stats.unknown++;
      log.info(`tnc: job ${pos}: unknown id`);
      continue;
    }
    const prev = state.submissions[id];
    if (prev?.state === "accepted") {
      stats.skipped++;
      log.info(`tnc: job ${pos}: already accepted, skipped`);
      continue;
    }
    let res: SubmissionResult;
    if (prev?.state === "sent" && prev.statusUrl) {
      res = await sink.refresh(prev.statusUrl);
    } else {
      if (posted && gap) await sleep(gap);
      posted = true;
      res = await sink.submit(r.job.url);
    }
    stats[res.state]++;
    log.info(`tnc: job ${pos}: ${res.state} (${res.detail})`);
    if (opts.record !== false) await record(state, id, r.job.url, res, now().toISOString());
  }
  return stats;
}

/** Re-check submissions still in progress (e.g. from the daily run). */
export async function refreshPending(state: State, sink: SubmissionSink, limit = 10, now = () => new Date()): Promise<number> {
  let n = 0;
  for (const [id, s] of Object.entries(state.submissions)) {
    if (n >= limit) break;
    if (s.state !== "sent" || !s.statusUrl || !state.jobs[id]) continue;
    const res = await sink.refresh(s.statusUrl);
    await record(state, id, state.jobs[id].job.url, res, now().toISOString());
    n++;
  }
  if (n) log.info(`tnc: refreshed ${n} pending submission(s)`);
  return n;
}
