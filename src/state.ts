import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Job } from "./types.js";

export const STATUSES = ["new", "saved", "applied", "interview", "offer", "rejected", "no"] as const;
export type Status = (typeof STATUSES)[number];
export const FEEDBACK = ["up", "down"] as const;
export type Feedback = (typeof FEEDBACK)[number];

export interface ScoreResult {
  score: number;
  fit_summary: string;
  matched_skills: string[];
  gaps: string[];
  red_flags: string[];
  confidence: "low" | "medium" | "high";
}

export interface ScoredInfo extends ScoreResult {
  /** Score after learned adjustments. */
  final: number;
  adjustment: number;
  /** Learned features behind the adjustment, e.g. "company:acme +3". */
  adjustReasons?: string[];
  provider: string;
  cacheKey: string;
  scoredAt: string;
}

export interface Draft {
  cv_bullets: string[];
  cover_note: string;
  createdAt: string;
  provider: string;
}

export interface JobRecord {
  job: Job;
  firstSeen: string;
  lastSeen: string;
  score?: ScoredInfo;
  status: Status;
  statusUpdatedAt?: string;
  history: { at: string; status: Status | Feedback }[];
  feedback?: Feedback;
  feedbackAt?: string;
  digestedAt?: string;
  digestedStatus?: Status;
}

export interface Learned {
  /** Derived automatically from statuses and thumbs. */
  auto: Record<string, number>;
  /** Hand-edited via `pnpm fitto learned set`; overrides auto for the same feature. */
  manual: Record<string, number>;
  updatedAt?: string;
}

export interface RunLog {
  at: string;
  kind: "daily" | "weekly" | "status";
  fetched?: number;
  newJobs?: number;
  scored?: number;
  sent?: number;
}

export interface State {
  version: 1;
  updatedAt?: string;
  jobs: Record<string, JobRecord>;
  scoreCache: Record<string, ScoreResult & { at: string; provider: string }>;
  drafts: Record<string, Draft>;
  learned: Learned;
  runs: RunLog[];
  weeklySentAt?: string;
}

export function emptyState(): State {
  return { version: 1, jobs: {}, scoreCache: {}, drafts: {}, learned: { auto: {}, manual: {} }, runs: [] };
}

// ---------- encryption ----------

interface Envelope {
  v: 1;
  alg: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encryptJson(value: unknown, secret: string): string {
  if (!secret || secret.length < 16) throw new Error("FITTO_STATE_KEY must be at least 16 characters");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
  const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(value))), cipher.final()]);
  const env: Envelope = {
    v: 1,
    alg: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(env);
}

export function decryptJson<T>(text: string, secret: string): T {
  const env = JSON.parse(text) as Envelope;
  if (env.v !== 1 || env.alg !== "aes-256-gcm") throw new Error("Unsupported state format");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, Buffer.from(env.salt, "base64")), Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]);
    return JSON.parse(gunzipSync(plain).toString("utf8")) as T;
  } catch {
    throw new Error("Could not decrypt state: wrong FITTO_STATE_KEY?");
  }
}

function migrate(s: Partial<State>): State {
  const base = emptyState();
  return { ...base, ...s, learned: { ...base.learned, ...s.learned }, version: 1 };
}

// ---------- stores ----------

export class StateConflictError extends Error {}

export interface Loaded {
  state: State;
  /** Opaque version token used for optimistic concurrency. */
  version: string | null;
}

export interface StateStore {
  describe(): string;
  load(): Promise<Loaded>;
  /** Throws StateConflictError if the stored version is no longer `base`. */
  save(state: State, base: string | null): Promise<string>;
}

/** Encrypted state in a local file (dev, dry-run and tests). */
export class FileStateStore implements StateStore {
  constructor(
    private readonly path: string,
    private readonly secret: string,
  ) {}
  describe() {
    return `file ${this.path}`;
  }
  async load(): Promise<Loaded> {
    if (!existsSync(this.path)) return { state: emptyState(), version: null };
    const text = readFileSync(this.path, "utf8");
    return { state: migrate(decryptJson<State>(text, this.secret)), version: text.slice(-24) };
  }
  async save(state: State, base: string | null): Promise<string> {
    const current = existsSync(this.path) ? readFileSync(this.path, "utf8").slice(-24) : null;
    if (current !== base) throw new StateConflictError("state changed since it was loaded");
    mkdirSync(dirname(this.path), { recursive: true });
    const text = encryptJson(state, this.secret);
    writeFileSync(this.path, text);
    return text.slice(-24);
  }
}

/**
 * Encrypted state stored as a single file on an orphan branch (default `fitto-state`).
 * Each save force-pushes a fresh one-commit branch using --force-with-lease, so
 * concurrent writers are detected rather than silently overwritten.
 */
export class GitBranchStateStore implements StateStore {
  constructor(
    private readonly secret: string,
    private readonly branch = "fitto-state",
    private readonly remote = "origin",
    private readonly file = "state.enc",
    private readonly cwd = process.cwd(),
  ) {}

  describe() {
    return `git branch ${this.branch}`;
  }

  private git(args: string[], input?: string): string {
    return execFileSync("git", args, {
      cwd: this.cwd,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fitto",
        GIT_AUTHOR_EMAIL: "fitto@users.noreply.github.com",
        GIT_COMMITTER_NAME: "fitto",
        GIT_COMMITTER_EMAIL: "fitto@users.noreply.github.com",
      },
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
  }

  async load(): Promise<Loaded> {
    const ref = `refs/remotes/${this.remote}/${this.branch}`;
    try {
      this.git(["fetch", "--quiet", "--no-tags", this.remote, `+refs/heads/${this.branch}:${ref}`]);
    } catch {
      return { state: emptyState(), version: null };
    }
    const sha = this.git(["rev-parse", ref]);
    const text = this.git(["show", `${sha}:${this.file}`]);
    return { state: migrate(decryptJson<State>(text, this.secret)), version: sha };
  }

  async save(state: State, base: string | null): Promise<string> {
    const blob = this.git(["hash-object", "-w", "--stdin"], encryptJson(state, this.secret));
    const tree = this.git(["mktree"], `100644 blob ${blob}\t${this.file}\n`);
    const commit = this.git(["commit-tree", tree, "-m", "Update encrypted Fitto state"]);
    try {
      this.git([
        "push",
        "--quiet",
        `--force-with-lease=refs/heads/${this.branch}:${base ?? ""}`,
        this.remote,
        `${commit}:refs/heads/${this.branch}`,
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/stale info|rejected|fetch first|non-fast-forward/i.test(msg)) {
        throw new StateConflictError("state branch changed since it was loaded");
      }
      throw new Error("Failed to push state branch (check `contents: write` permission / git credentials)");
    }
    this.git(["update-ref", `refs/remotes/${this.remote}/${this.branch}`, commit]);
    return commit;
  }
}

export function stateStoreFromEnv(env = process.env): StateStore {
  const secret = env.FITTO_STATE_KEY?.trim();
  if (!secret) throw new Error("FITTO_STATE_KEY is not set (see SETUP.md)");
  if (env.FITTO_STATE_FILE) return new FileStateStore(env.FITTO_STATE_FILE, secret);
  return new GitBranchStateStore(secret, env.FITTO_STATE_BRANCH ?? "fitto-state");
}

// ---------- merging ----------

const later = (a?: string, b?: string) => (b && (!a || b > a) ? "b" : "a");

/** Merge two diverged states: user actions (status/feedback/learned edits) win by timestamp. */
export function mergeStates(ours: State, theirs: State): State {
  const out: State = structuredClone(ours);
  for (const [id, t] of Object.entries(theirs.jobs)) {
    const o = out.jobs[id];
    if (!o) {
      out.jobs[id] = structuredClone(t);
      continue;
    }
    if (later(o.statusUpdatedAt, t.statusUpdatedAt) === "b") {
      o.status = t.status;
      o.statusUpdatedAt = t.statusUpdatedAt;
    }
    if (later(o.feedbackAt, t.feedbackAt) === "b") {
      o.feedback = t.feedback;
      o.feedbackAt = t.feedbackAt;
    }
    const seen = new Set(o.history.map((h) => `${h.at}|${h.status}`));
    for (const h of t.history) if (!seen.has(`${h.at}|${h.status}`)) o.history.push(h);
    o.history.sort((a, b) => a.at.localeCompare(b.at));
    if (later(o.digestedAt, t.digestedAt) === "b") {
      o.digestedAt = t.digestedAt;
      o.digestedStatus = t.digestedStatus;
    }
  }
  if (later(out.learned.updatedAt, theirs.learned.updatedAt) === "b") out.learned = structuredClone(theirs.learned);
  out.scoreCache = { ...theirs.scoreCache, ...out.scoreCache };
  out.drafts = { ...theirs.drafts, ...out.drafts };
  const runs = new Map([...theirs.runs, ...out.runs].map((r) => [`${r.at}|${r.kind}`, r]));
  out.runs = [...runs.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-200);
  if (later(out.weeklySentAt, theirs.weeklySentAt) === "b") out.weeklySentAt = theirs.weeklySentAt;
  return out;
}

/** Save with optimistic concurrency: on conflict reload, merge and retry. */
export async function saveState(store: StateStore, state: State, base: string | null, attempts = 4): Promise<State> {
  let current = state;
  let version = base;
  for (let i = 0; ; i++) {
    current.updatedAt = new Date().toISOString();
    try {
      await store.save(current, version);
      return current;
    } catch (e) {
      if (!(e instanceof StateConflictError) || i >= attempts - 1) throw e;
      const remote = await store.load();
      current = mergeStates(current, remote.state);
      version = remote.version;
    }
  }
}

/** Apply a user mutation (status, feedback, learned edit) with reload-and-retry on conflict. */
export async function updateState(store: StateStore, mutate: (s: State) => void, attempts = 4): Promise<State> {
  for (let i = 0; ; i++) {
    const { state, version } = await store.load();
    mutate(state);
    state.updatedAt = new Date().toISOString();
    try {
      await store.save(state, version);
      return state;
    } catch (e) {
      if (!(e instanceof StateConflictError) || i >= attempts - 1) throw e;
    }
  }
}

/** Drop stale, untouched jobs and old cache entries to keep the state small. */
export function pruneState(s: State, now = Date.now()): void {
  const day = 86_400_000;
  for (const [id, r] of Object.entries(s.jobs)) {
    const age = now - Date.parse(r.lastSeen);
    if (r.status === "new" && !r.feedback && age > 45 * day) {
      delete s.jobs[id];
      delete s.drafts[id];
    }
  }
  for (const [k, v] of Object.entries(s.scoreCache)) if (now - Date.parse(v.at) > 60 * day) delete s.scoreCache[k];
  s.runs = s.runs.slice(-200);
}
