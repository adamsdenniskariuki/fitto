import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";

export const AtsSchema = z.enum(["greenhouse", "lever", "ashby", "workable"]);
export type Ats = z.infer<typeof AtsSchema>;

export const CompaniesSchema = z.object({
  companies: z
    .array(
      z.object({
        name: z.string(),
        ats: AtsSchema,
        slug: z.string(),
      }),
    )
    .default([]),
  boards: z
    .object({
      remotive: z.object({ enabled: z.boolean().default(true), category: z.string().default("software-dev") }).optional(),
      weworkremotely: z
        .object({
          enabled: z.boolean().default(true),
          feeds: z.array(z.string()).default(["remote-programming-jobs"]),
        })
        .optional(),
      remoteok: z.object({ enabled: z.boolean().default(true) }).optional(),
      hn: z.object({ enabled: z.boolean().default(true), maxComments: z.number().int().default(400) }).optional(),
    })
    .default({}),
  settings: z
    .object({
      max_age_days: z.number().int().positive().default(30),
    })
    .default({ max_age_days: 30 }),
});
export type CompaniesConfig = z.infer<typeof CompaniesSchema>;

export const ProfileSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  headline: z.string().default(""),
  summary: z.string().default(""),
  skills: z.array(z.string()).default([]),
  nice_to_have: z.array(z.string()).default([]),
  years_experience: z.number().optional(),
  seniority: z.array(z.string()).default([]),
  title_keywords: z.array(z.string()).default([]),
  exclude_title_keywords: z.array(z.string()).default([]),
  locations: z
    .object({
      remote: z.boolean().default(true),
      onsite_cities: z.array(z.string()).default([]),
      countries: z.array(z.string()).default([]),
      /** Phrases that make a remote role unavailable to you, e.g. "US only". */
      exclude: z.array(z.string()).default([]),
    })
    .default({ remote: true, onsite_cities: [], countries: [], exclude: [] }),
  salary: z
    .object({
      min: z.number().optional(),
      currency: z.string().default("USD"),
      // Extra annual floors for other currencies, e.g. { EUR: 55000, GBP: 50000 }.
      floors: z.record(z.string(), z.number()).default({}),
    })
    .optional(),
  dealbreakers: z.array(z.string()).default([]),
  digest: z
    .object({
      min_score: z.number().default(60),
      top_n: z.number().int().default(10),
    })
    .default({ min_score: 60, top_n: 10 }),
  cv: z.string().default(""),
});
export type Profile = z.infer<typeof ProfileSchema>;

function loadYaml<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch {
    // Do not include the parser message: it may quote private content.
    throw new Error(`${what} is not valid YAML`);
  }
  const res = schema.safeParse(data ?? {});
  if (!res.success) {
    const paths = res.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new Error(`${what} is invalid at: ${paths}`);
  }
  return res.data;
}

/** Loads the watchlist: FITTO_COMPANIES secret (YAML) overrides companies.yaml. */
export function loadCompanies(env = process.env, path = "companies.yaml"): CompaniesConfig {
  if (env.FITTO_COMPANIES?.trim()) return loadYaml(CompaniesSchema, env.FITTO_COMPANIES, "FITTO_COMPANIES");
  if (existsSync(path)) return loadYaml(CompaniesSchema, readFileSync(path, "utf8"), path);
  return CompaniesSchema.parse({});
}

/** Loads the profile from the FITTO_PROFILE secret, or a git-ignored local profile.yaml. */
export function loadProfile(env = process.env, path = "profile.yaml"): Profile {
  if (env.FITTO_PROFILE?.trim()) return loadYaml(ProfileSchema, env.FITTO_PROFILE, "FITTO_PROFILE");
  const p = env.FITTO_PROFILE_FILE ?? path;
  if (existsSync(p)) return loadYaml(ProfileSchema, readFileSync(p, "utf8"), p);
  throw new Error("No profile found. Set the FITTO_PROFILE secret or create profile.yaml (see profile.example.yaml).");
}

export function profileHash(p: Profile): string {
  return createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 16);
}

export interface Settings {
  dryRun: boolean;
  repo: string;
  stateKey?: string;
  maxLlmCalls: number;
  maxDrafts: number;
  model: string;
}

export function loadSettings(env = process.env): Settings {
  return {
    dryRun: env.FITTO_DRY_RUN === "1" || env.FITTO_DRY_RUN === "true",
    repo: env.GITHUB_REPOSITORY ?? "adamsdenniskariuki/fitto",
    stateKey: env.FITTO_STATE_KEY?.trim() || undefined,
    maxLlmCalls: Number(env.FITTO_MAX_LLM_CALLS || 40),
    maxDrafts: Number(env.FITTO_MAX_DRAFTS || 3),
    model: env.FITTO_MODEL ?? "",
  };
}
