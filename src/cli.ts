#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { buildContext, scorerFromEnv, stateStoreFor } from "./context.js";
import { runDaily } from "./daily.js";
import { runGolden } from "./golden.js";
import { HttpClient } from "./http.js";
import { inActions, log } from "./log.js";
import { loadCompanies, loadProfile, loadSettings } from "./config.js";
import { buildSitePayload, encryptForSite, writeSiteExport } from "./site.js";
import { buildTasks, fetchAll } from "./sources/index.js";
import { saveState, stateStoreFromEnv, updateState } from "./state.js";
import { applyStatus, parseIds, STATUS_VALUES } from "./status.js";
import { renderTracker } from "./tracker.js";
import { FEATURE_RE, fewShotExamples, learnWeights, MAX_TOTAL, renderLearned } from "./learn.js";
import { runWeekly } from "./weekly.js";
import { refreshPending, submitJobs, tncSinkFromEnv } from "./submit.js";

const USAGE = `Usage: pnpm fitto <command>

Commands:
  run                     Daily run: fetch, filter, score, email the digest, save encrypted state
  weekly [--force]        Email the weekly summary
  status <ids> <status>   Set status for comma-separated job ids: ${STATUS_VALUES.join(", ")}
  tracker [--all]         Decrypt the state and print your job tracker (local use only)
  learned [show|set <feature> <points>|unset <feature>|reset]
                          Show or edit learned boosts/penalties (local use only)
  tnc <ids> | tnc refresh Send the selected jobs to The Next Chapter (never automatic), or re-check pending ones
  site-export [path]      Write the passphrase-encrypted job list for the site (needs FITTO_SITE_PASSPHRASE)
  fetch                   Fetch and normalise jobs; prints per-source counts only
  eval                    Score the golden fixtures with the configured provider and check bands
  keygen                  Print a new random key (FITTO_STATE_KEY / FITTO_SITE_PASSPHRASE)
  help                    Show this help

Environment: FITTO_DRY_RUN=1 uses profile.example.yaml (if no profile), local state in .fitto/,
and writes messages to out/ instead of sending them.
`;

function store() {
  return stateStoreFor(process.env, loadSettings().dryRun);
}

async function cmdStatus(idsArg?: string, value?: string): Promise<number> {
  if (!idsArg || !value) {
    console.error("Usage: pnpm fitto status <id[,id...]> <status>");
    return 2;
  }
  const ids = parseIds(idsArg);
  let res = { updated: 0, unknown: 0 };
  await updateState(store(), (s) => {
    res = applyStatus(s, ids, value.toLowerCase());
  });
  log.info(`status: ${res.updated} updated, ${res.unknown} unknown id(s)`);
  return res.unknown && !res.updated ? 1 : 0;
}

async function cmdTnc(arg?: string): Promise<number> {
  if (!arg) {
    console.error("Usage: pnpm fitto tnc <id[,id...]> | refresh");
    return 2;
  }
  const dryRun = loadSettings().dryRun;
  const sink = tncSinkFromEnv(process.env, dryRun);
  // A dry run in Actions reads the real encrypted state (read-only) so ids resolve.
  const st = dryRun && process.env.GITHUB_ACTIONS && process.env.FITTO_STATE_KEY ? stateStoreFromEnv(process.env) : store();
  const { state, version } = await st.load();
  const at = new Date().toISOString();
  if (arg === "refresh") {
    await refreshPending(state, sink, 50);
  } else {
    const s = await submitJobs(state, parseIds(arg), sink, { record: !dryRun });
    log.info(
      `tnc: ${s.requested} requested: ${s.accepted} accepted, ${s.sent} sent (in progress), ${s.failed} failed, ${s.skipped} skipped, ${s.unknown} unknown${dryRun ? " (dry run: nothing sent)" : ""}`,
    );
    state.runs.push({ at, kind: "tnc", sent: s.accepted + s.sent });
    if (s.unknown === s.requested) return 1;
  }
  if (!dryRun) await saveState(st, state, version);
  return 0;
}

async function cmdLearned(args: string[]): Promise<number> {
  if (inActions()) {
    log.error("learned prints personal data; run it locally, not in Actions");
    return 2;
  }
  const [sub = "show", feature, value] = args;
  if (sub === "show") {
    const { state } = await store().load();
    console.log(renderLearned({ ...state.learned, auto: learnWeights(state) }, fewShotExamples(state)));
    return 0;
  }
  if ((sub === "set" || sub === "unset") && (!feature || !FEATURE_RE.test(feature))) {
    console.error("feature must look like company:acme, title:backend or skill:go");
    return 2;
  }
  const points = Number(value);
  if (sub === "set" && (!Number.isFinite(points) || Math.abs(points) > MAX_TOTAL)) {
    console.error(`points must be a number between -${MAX_TOTAL} and ${MAX_TOTAL}`);
    return 2;
  }
  if (!["set", "unset", "reset"].includes(sub)) {
    console.error("Usage: pnpm fitto learned [show | set <feature> <points> | unset <feature> | reset]");
    return 2;
  }
  await updateState(store(), (s) => {
    if (sub === "set") s.learned.manual[feature!] = points;
    if (sub === "unset") delete s.learned.manual[feature!];
    if (sub === "reset") s.learned.manual = {};
    s.learned.updatedAt = new Date().toISOString();
  });
  log.info(`learned: ${sub} saved (applies from the next run)`);
  return 0;
}

async function cmdTracker(all: boolean): Promise<number> {
  if (inActions()) {
    log.error("tracker prints personal data; run it locally, not in Actions");
    return 2;
  }
  const { state } = await store().load();
  console.log(renderTracker(state, { all }));
  return 0;
}

async function cmdSiteExport(out = "_site/data/matches.enc.json"): Promise<number> {
  const passphrase = process.env.FITTO_SITE_PASSPHRASE;
  if (!passphrase) {
    log.warn("site-export: FITTO_SITE_PASSPHRASE is not set; nothing written");
    return 0;
  }
  let minScore = 60;
  try {
    minScore = loadProfile().digest.min_score;
  } catch {
    log.info("site-export: no profile available; using min score 60");
  }
  const { state } = await store().load();
  const payload = buildSitePayload(state, { minScore, repo: process.env.GITHUB_REPOSITORY || "adamsdenniskariuki/fitto" });
  writeSiteExport(out, encryptForSite(payload, passphrase));
  log.info(`site-export: wrote encrypted list (${payload.jobs.length} jobs)`);
  return 0;
}

async function cmdFetch(): Promise<void> {
  const settings = loadSettings();
  const companies = loadCompanies();
  const { jobs, stats } = await fetchAll(buildTasks(new HttpClient(), companies), {
    secret: settings.stateKey,
    maxAgeDays: companies.settings.max_age_days,
  });
  for (const s of stats) log.info(`${s.label}: ${s.error ? `error (${s.error})` : s.count}`);
  log.info(`total after dedupe: ${jobs.length}`);
}

async function cmdEval(): Promise<number> {
  const scorer = scorerFromEnv(process.env);
  const results = await runGolden(scorer);
  let failed = 0;
  for (const r of results) {
    const ok = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failed++;
    console.log(`${ok}  ${r.name.padEnd(40)} ${r.detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} golden cases within expected bands (${scorer.name})`);
  return failed ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  switch (cmd) {
    case "run":
      await runDaily(buildContext());
      return 0;
    case "weekly":
      await runWeekly(buildContext(), argv.includes("--force"));
      return 0;
    case "status":
      return cmdStatus(argv[1], argv[2]);
    case "tracker":
      return cmdTracker(argv.includes("--all"));
    case "learned":
      return cmdLearned(argv.slice(1));
    case "tnc":
      return cmdTnc(argv[1]);
    case "site-export":
      return cmdSiteExport(argv[1]);
    case "fetch":
      await cmdFetch();
      return 0;
    case "eval":
      return cmdEval();
    case "keygen":
      process.stdout.write(randomBytes(32).toString("base64") + "\n");
      return 0;
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
