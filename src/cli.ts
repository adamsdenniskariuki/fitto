#!/usr/bin/env node
import { loadCompanies, loadSettings } from "./config.js";
import { HttpClient } from "./http.js";
import { log } from "./log.js";
import { buildTasks, fetchAll } from "./sources/index.js";

const USAGE = `Usage: pnpm fitto <command>

Commands:
  fetch        Fetch and normalise jobs from all sources; prints per-source counts only
  help         Show this help
`;

async function cmdFetch(): Promise<void> {
  const settings = loadSettings();
  const companies = loadCompanies();
  const http = new HttpClient();
  const { jobs, stats } = await fetchAll(buildTasks(http, companies), {
    secret: settings.stateKey,
    maxAgeDays: companies.settings.max_age_days,
  });
  for (const s of stats) log.info(`${s.label}: ${s.error ? `error (${s.error})` : s.count}`);
  log.info(`total after dedupe: ${jobs.length}`);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  switch (cmd) {
    case "fetch":
      await cmdFetch();
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
