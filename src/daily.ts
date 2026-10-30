import type { Context } from "./context.js";
import { HttpClient } from "./http.js";
import { log } from "./log.js";
import { ingest } from "./pipeline.js";
import { scoreJobs } from "./score.js";
import { markDigested, renderDigest, selectDigest } from "./digest.js";
import { deliver } from "./sinks/index.js";
import { adjustmentFor, fewShotExamples, learnWeights } from "./learn.js";
import { generateDrafts } from "./drafts.js";
import { refreshPending, tncSinkFromEnv } from "./submit.js";
import { buildTasks, fetchAll } from "./sources/index.js";
import { pruneState, saveState } from "./state.js";

export interface DailyResult {
  fetched: number;
  passed: number;
  newJobs: number;
  scored: number;
  sent: number;
}

/** Daily run: fetch, filter, score, persist. Logs aggregate counts only. */
export async function runDaily(ctx: Context, http = new HttpClient()): Promise<DailyResult> {
  const now = new Date();
  const { state, version } = await ctx.store.load();
  log.info(`state loaded from ${ctx.store.describe()}`);

  const { jobs, stats: sourceStats } = await fetchAll(buildTasks(http, ctx.companies), {
    secret: ctx.idSecret,
    maxAgeDays: ctx.companies.settings.max_age_days,
  });
  const failed = sourceStats.filter((s) => s.error).length;
  log.info(`fetched ${jobs.length} jobs from ${sourceStats.length} sources (${failed} failed)`);

  const { ids, stats } = ingest(state, jobs, ctx.profile, now);
  log.info(`hard filters: ${stats.passed} passed, ${stats.newJobs} new`);

  state.learned.auto = learnWeights(state);
  const s = await scoreJobs(state, ids, {
    scorer: ctx.scorer,
    profile: ctx.profile,
    maxCalls: ctx.settings.maxLlmCalls,
    examples: fewShotExamples(state),
    adjust: (job, r) => adjustmentFor(state.learned, job, r),
    now,
  });
  log.info(
    `scoring (${ctx.scorer.name}): ${s.calls} calls, ${s.cacheHits} cached, ${s.failures} failed, ${s.deferred} deferred${s.rateLimited ? " (rate limited)" : ""}` +
      (Object.keys(s.errors).length
        ? `; failures: ${Object.entries(s.errors)
            .map(([k, v]) => `${k} x${v}`)
            .join(", ")}`
        : ""),
  );

  await generateDrafts(state, { provider: ctx.provider, profile: ctx.profile, max: ctx.settings.maxDrafts, now });

  if (!ctx.settings.dryRun && ctx.env.TNC_API_TOKEN && Object.values(state.submissions).some((x) => x.state === "sent")) {
    await refreshPending(state, tncSinkFromEnv(ctx.env, false)).catch((e: unknown) =>
      log.warn(`tnc: refresh failed (${e instanceof Error ? e.name : "error"})`),
    );
  }

  const picks = selectDigest(state, ctx.profile);
  let sent = 0;
  if (!picks.length) log.info("digest: no new matches today");
  else if (await deliver(ctx.sinks, renderDigest(picks, state, ctx.links, now))) {
    markDigested(picks, now);
    sent = picks.length;
  }

  pruneState(state, now.getTime());
  state.runs.push({ at: now.toISOString(), kind: "daily", fetched: jobs.length, newJobs: stats.newJobs, scored: s.calls, sent });
  await saveState(ctx.store, state, version);
  log.info("state saved");
  return { fetched: jobs.length, passed: stats.passed, newJobs: stats.newJobs, scored: s.calls, sent };
}
