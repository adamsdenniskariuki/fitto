import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ProfileSchema } from "./config.js";
import { hardFilter } from "./filters.js";
import { finalize } from "./normalize.js";
import type { Scorer } from "./score.js";
import type { RawJob } from "./types.js";

interface GoldenCase {
  name: string;
  job: Partial<RawJob> & { title: string; company: string; description: string };
  /** Expected hard-filter outcome; a reason string means it must be filtered for that reason. */
  filtered?: string;
  /** Inclusive expected score band, e.g. [70, 100]. */
  band?: [number, number];
}

interface GoldenFile {
  profile: unknown;
  cases: GoldenCase[];
}

export interface GoldenResult {
  name: string;
  ok: boolean;
  detail: string;
}

export const GOLDEN_PATH = fileURLToPath(new URL("../tests/fixtures/golden.yaml", import.meta.url));

/** Runs the synthetic golden set (no personal data) through filters and a scorer. */
export async function runGolden(scorer: Scorer, path = GOLDEN_PATH): Promise<GoldenResult[]> {
  const file = YAML.parse(readFileSync(path, "utf8")) as GoldenFile;
  const profile = ProfileSchema.parse(file.profile);
  const out: GoldenResult[] = [];
  for (const c of file.cases) {
    const job = finalize({
      source: "golden",
      sourceId: c.name,
      location: "Remote",
      remote: true,
      url: "https://example.com",
      tags: [],
      ...c.job,
    });
    const f = hardFilter(job, profile);
    if (c.filtered) {
      out.push({ name: c.name, ok: !f.pass && f.reason === c.filtered, detail: `filter=${f.pass ? "pass" : f.reason}` });
      continue;
    }
    if (!f.pass) {
      out.push({ name: c.name, ok: false, detail: `unexpectedly filtered (${f.reason})` });
      continue;
    }
    if (!c.band) continue;
    try {
      const r = await scorer.score(job, profile, []);
      const [lo, hi] = c.band;
      out.push({ name: c.name, ok: r.score >= lo && r.score <= hi, detail: `score=${r.score} band=[${lo},${hi}]` });
    } catch (e) {
      out.push({ name: c.name, ok: false, detail: `error: ${e instanceof Error ? e.message : e}` });
    }
  }
  return out;
}
