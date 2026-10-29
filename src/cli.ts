#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { buildContext, scorerFromEnv, stateStoreFor } from "./context.js";
import { runDaily } from "./daily.js";
import { runGolden } from "./golden.js";
import { HttpClient } from "./http.js";
import { inActions, log } from "./log.js";
import { loadCompanies, loadSettings } from "./config.js";
import { buildTasks, fetchAll } from "./sources/index.js";
import { updateState } from "./state.js";
import { applyStatus, parseIds, STATUS_VALUES } from "./status.js";
import { renderTracker } from "./tracker.js";
import { runWeekly } from "./weekly.js";

const USAGE = `Usage: pnpm fitto <command>

Commands:
  run                     Daily run: fetch, filter, score, email the digest, save encrypted state
  weekly [--force]        Email the weekly summary
  status <ids> <status>   Set status for comma-separated job ids: ${STATUS_VALUES.join(", ")}
  tracker [--all]         Decrypt the state and print your job tracker (local use only)
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

async function cmdTracker(all: boolean): Promise<number> {
  if (inActions()) {
    log.error("tracker prints personal data; run it locally, not in Actions");
    return 2;
  }
  const { state } = await store().load();
  console.log(renderTracker(state, { all }));
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
