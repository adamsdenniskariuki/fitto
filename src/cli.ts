#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { buildContext, scorerFromEnv } from "./context.js";
import { runDaily } from "./daily.js";
import { runGolden } from "./golden.js";
import { HttpClient } from "./http.js";
import { log } from "./log.js";
import { loadCompanies, loadSettings } from "./config.js";
import { buildTasks, fetchAll } from "./sources/index.js";

const USAGE = `Usage: pnpm fitto <command>

Commands:
  run          Daily run: fetch, filter, score and save encrypted state
  fetch        Fetch and normalise jobs; prints per-source counts only
  eval         Score the golden fixtures with the configured provider and check bands
  keygen       Print a new random FITTO_STATE_KEY (pipe it into gh secret set)
  help         Show this help

Environment: FITTO_DRY_RUN=1 runs with local placeholder state and no delivery.
`;

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
