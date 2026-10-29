import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inActions, log } from "../log.js";
import type { Message, Sink } from "./types.js";

/**
 * Dry-run delivery. In GitHub Actions it writes only the redacted form (counts)
 * to the public job summary. Locally it writes the full message to the
 * git-ignored out/ directory.
 */
export class DryRunSink implements Sink {
  name = "dry-run";
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly outDir = "out",
  ) {}
  async send(m: Message): Promise<void> {
    if (inActions() || this.env.GITHUB_STEP_SUMMARY) {
      if (this.env.GITHUB_STEP_SUMMARY) appendFileSync(this.env.GITHUB_STEP_SUMMARY, `${m.redacted}\n`);
      log.info(`dry run: ${m.kind} message with ${m.count} jobs (redacted summary only)`);
      return;
    }
    mkdirSync(this.outDir, { recursive: true });
    writeFileSync(join(this.outDir, `${m.kind}.html`), m.html);
    writeFileSync(join(this.outDir, `${m.kind}.txt`), m.text);
    log.info(`dry run: wrote ${this.outDir}/${m.kind}.html and .txt (${m.count} jobs)`);
  }
}
