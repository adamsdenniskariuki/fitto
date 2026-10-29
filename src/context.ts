import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { loadCompanies, loadProfile, loadSettings, ProfileSchema, type CompaniesConfig, type Profile, type Settings } from "./config.js";
import { providerFromEnv } from "./llm/provider.js";
import { log, mask } from "./log.js";
import { HeuristicScorer, LlmScorer, type Scorer } from "./score.js";
import { sinksFromEnv, type Sink } from "./sinks/index.js";
import { FileStateStore, stateStoreFromEnv, type StateStore } from "./state.js";
import type { Links } from "./digest.js";

export const DRY_RUN_KEY = "fitto-dry-run-local-key-not-secret";

export interface Context {
  env: NodeJS.ProcessEnv;
  settings: Settings;
  profile: Profile;
  companies: CompaniesConfig;
  store: StateStore;
  scorer: Scorer;
  /** Secret used to derive opaque job ids. */
  idSecret: string;
  sinks: Sink[];
  links: Links;
}

function loadProfileForRun(env: NodeJS.ProcessEnv, dryRun: boolean): Profile {
  try {
    return loadProfile(env);
  } catch (e) {
    if (!dryRun || !existsSync("profile.example.yaml")) throw e;
    log.warn("dry run: no profile configured, using profile.example.yaml");
    return ProfileSchema.parse(YAML.parse(readFileSync("profile.example.yaml", "utf8")));
  }
}

export function stateStoreFor(env: NodeJS.ProcessEnv, dryRun: boolean): StateStore {
  if (dryRun) return new FileStateStore(env.FITTO_STATE_FILE ?? ".fitto/dry-run.state.enc", env.FITTO_STATE_KEY || DRY_RUN_KEY);
  return stateStoreFromEnv(env);
}

export function scorerFromEnv(env: NodeJS.ProcessEnv): Scorer {
  const provider = providerFromEnv(env);
  return provider ? new LlmScorer(provider) : new HeuristicScorer();
}

export function buildContext(env = process.env): Context {
  const settings = loadSettings(env);
  const profile = loadProfileForRun(env, settings.dryRun);
  mask(profile.name);
  mask(profile.email);
  mask(env.FITTO_EMAIL_TO);
  return {
    env,
    settings,
    profile,
    companies: loadCompanies(env),
    store: stateStoreFor(env, settings.dryRun),
    scorer: scorerFromEnv(env),
    idSecret: settings.stateKey ?? DRY_RUN_KEY,
    sinks: sinksFromEnv(env, settings.dryRun),
    links: { repo: settings.repo, site: env.FITTO_SITE_URL || undefined },
  };
}
