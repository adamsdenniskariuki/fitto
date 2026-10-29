/**
 * Logging that is safe for a public repository: callers must only pass
 * aggregate, non-personal information (counts, source names, public slugs).
 */
const quiet = (): boolean => process.env.FITTO_QUIET === "1" || (process.env.VITEST === "true" && process.env.FITTO_LOG_IN_TESTS !== "1");

export const log = {
  info(msg: string): void {
    if (!quiet()) console.log(`[fitto] ${msg}`);
  },
  warn(msg: string): void {
    if (!quiet()) console.warn(`[fitto] warning: ${msg}`);
  },
  error(msg: string): void {
    console.error(`[fitto] error: ${msg}`);
  },
};

export const inActions = (): boolean => process.env.GITHUB_ACTIONS === "true";

/** Ask GitHub Actions to mask a value in all subsequent log output. */
export function mask(value: string | undefined): void {
  if (!inActions() || !value) return;
  for (const line of value.split(/\r?\n/)) {
    const v = line.trim();
    if (v.length >= 3) console.log(`::add-mask::${v}`);
  }
}
