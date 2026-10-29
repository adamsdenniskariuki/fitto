import { log } from "../log.js";
import { DryRunSink } from "./dryrun.js";
import { emailSinkFromEnv } from "./email.js";
import type { Message, Sink } from "./types.js";

export type { Message, Sink } from "./types.js";

/** Configured sinks. Dry run, or no channel configured, falls back to the redacted dry-run sink. */
export function sinksFromEnv(env: NodeJS.ProcessEnv, dryRun: boolean): Sink[] {
  if (dryRun) return [new DryRunSink(env)];
  const sinks = [emailSinkFromEnv(env)].filter((s): s is Sink => !!s);
  if (!sinks.length) {
    log.warn("no delivery channel configured (set FITTO_EMAIL_TO plus SMTP_* or RESEND_API_KEY); writing a redacted summary only");
    return [new DryRunSink(env)];
  }
  return sinks;
}

/** Deliver to every sink; returns true if at least one succeeded. Errors are logged without content. */
export async function deliver(sinks: Sink[], m: Message): Promise<boolean> {
  let ok = false;
  for (const s of sinks) {
    try {
      await s.send(m);
      ok = true;
      log.info(`${m.kind}: delivered ${m.count} jobs via ${s.name}`);
    } catch (e) {
      log.error(`${m.kind}: delivery via ${s.name} failed (${e instanceof Error ? e.name : "error"})`);
    }
  }
  return ok;
}
