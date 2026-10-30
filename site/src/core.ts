/**
 * DOM-free logic for the Fitto site, unit-tested in Node (tests/site.test.ts).
 * Nothing here sends the passphrase or the decrypted data anywhere. Tokens go only to the API they are for.
 */
import type { SiteEnvelope, SiteJob, SitePayload } from "../../src/site-types.js";
import { CorsBlockedError, TncSink, type SubmissionResult } from "../../src/sinks/tnc.js";

export { CorsBlockedError };
export type { SiteEnvelope, SiteJob, SitePayload, SubmissionResult };

export const DEFAULT_REPO = "adamsdenniskariuki/fitto";
export const MAX_SELECTED = 50;
export const ID_RE = /^[0-9a-f]{6,64}$/;
const SEND_GAP_MS = 3_000;

// ---------- decryption ----------

export class WrongPassphraseError extends Error {
  constructor() {
    super("That passphrase didn't unlock the list.");
    this.name = "WrongPassphraseError";
  }
}

const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export async function decryptEnvelope(env: SiteEnvelope, passphrase: string): Promise<SitePayload> {
  if (env?.v !== 1 || env.kdf !== "PBKDF2-SHA256" || env.alg !== "AES-256-GCM") throw new Error("Unsupported data format.");
  if (!Number.isInteger(env.iter) || env.iter < 100_000 || env.iter > 10_000_000) throw new Error("Unsupported data format.");
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64(env.salt), iterations: env.iter },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(env.iv) }, key, fromB64(env.ct));
  } catch {
    throw new WrongPassphraseError();
  }
  const payload = JSON.parse(new TextDecoder().decode(plain)) as SitePayload;
  if (payload?.v !== 1 || !Array.isArray(payload.jobs)) throw new Error("Unsupported data format.");
  return payload;
}

// ---------- local state (statuses, sends, settings, tokens) ----------

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryKV implements KV {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

export const LOCAL_STATUSES = ["saved", "applied", "dismissed"] as const;
export type LocalStatus = (typeof LOCAL_STATUSES)[number];
export type SendState = "queued" | "sent" | "accepted" | "failed";
export type SendMode = "action" | "direct";

export interface LocalSend {
  state: SendState;
  detail: string;
  at: string;
  via: SendMode;
}

export interface Settings {
  mode: SendMode;
  repo: string;
}

const K = {
  statuses: "fitto.statuses",
  sends: "fitto.sends",
  settings: "fitto.settings",
  passphrase: "fitto.passphrase",
  ghToken: "fitto.ghToken",
  tncToken: "fitto.tncToken",
} as const;
export type Secret = "passphrase" | "ghToken" | "tncToken";

const readJson = <T>(kv: KV, key: string, fallback: T): T => {
  try {
    const v = kv.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Per-device state. `local` is localStorage, `session` is sessionStorage: secrets live in session storage
 * unless the user ticks "remember on this device".
 */
export class SiteStore {
  constructor(
    private readonly local: KV,
    private readonly session: KV,
  ) {}

  get statuses(): Record<string, { status: LocalStatus; at: string }> {
    return readJson(this.local, K.statuses, {});
  }
  setStatus(id: string, status: LocalStatus | undefined, now = new Date()): void {
    const all = this.statuses;
    if (status) all[id] = { status, at: now.toISOString() };
    else delete all[id];
    this.local.setItem(K.statuses, JSON.stringify(all));
  }

  get sends(): Record<string, LocalSend> {
    return readJson(this.local, K.sends, {});
  }
  setSend(id: string, send: LocalSend): void {
    const all = this.sends;
    all[id] = send;
    this.local.setItem(K.sends, JSON.stringify(all));
  }

  get settings(): Settings {
    const s = readJson<Partial<Settings>>(this.local, K.settings, {});
    return { mode: s.mode === "direct" ? "direct" : "action", repo: s.repo && /^[\w.-]+\/[\w.-]+$/.test(s.repo) ? s.repo : DEFAULT_REPO };
  }
  saveSettings(s: Partial<Settings>): void {
    this.local.setItem(K.settings, JSON.stringify({ ...this.settings, ...s }));
  }

  getSecret(name: Secret): string | undefined {
    return this.session.getItem(K[name]) ?? this.local.getItem(K[name]) ?? undefined;
  }
  setSecret(name: Secret, value: string, remember: boolean): void {
    this.forgetSecret(name);
    (remember ? this.local : this.session).setItem(K[name], value);
  }
  forgetSecret(name: Secret): void {
    this.local.removeItem(K[name]);
    this.session.removeItem(K[name]);
  }
  isRemembered(name: Secret): boolean {
    return this.local.getItem(K[name]) !== null;
  }

  /** Statuses and send results only; never tokens or the passphrase. */
  exportData(now = new Date()): string {
    return JSON.stringify({ fitto: 1, exportedAt: now.toISOString(), statuses: this.statuses, sends: this.sends }, null, 2);
  }

  importData(json: string): { statuses: number; sends: number } {
    const d = JSON.parse(json) as { fitto?: number; statuses?: unknown; sends?: unknown };
    if (d?.fitto !== 1) throw new Error("Not a Fitto export file.");
    const statuses = this.statuses;
    let ns = 0;
    for (const [id, v] of Object.entries((d.statuses ?? {}) as Record<string, { status?: string; at?: string }>)) {
      if (!ID_RE.test(id) || !LOCAL_STATUSES.includes(v?.status as LocalStatus) || typeof v.at !== "string") continue;
      if (!statuses[id] || statuses[id].at < v.at) {
        statuses[id] = { status: v.status as LocalStatus, at: v.at };
        ns++;
      }
    }
    const sends = this.sends;
    let nd = 0;
    for (const [id, v] of Object.entries((d.sends ?? {}) as Record<string, Partial<LocalSend>>)) {
      if (!ID_RE.test(id) || !["queued", "sent", "accepted", "failed"].includes(v?.state ?? "") || typeof v.at !== "string") continue;
      if (!sends[id] || sends[id].at < v.at) {
        sends[id] = { state: v.state as SendState, detail: String(v.detail ?? "").slice(0, 40), at: v.at, via: v.via === "direct" ? "direct" : "action" };
        nd++;
      }
    }
    this.local.setItem(K.statuses, JSON.stringify(statuses));
    this.local.setItem(K.sends, JSON.stringify(sends));
    return { statuses: ns, sends: nd };
  }

  /** "Forget this device": removes every Fitto key from both storages. */
  forgetAll(): void {
    for (const k of Object.values(K)) {
      this.local.removeItem(k);
      this.session.removeItem(k);
    }
  }
}

// ---------- selection rules ----------

export interface EffectiveSend {
  state: SendState;
  detail: string;
  at: string;
  source: "server" | "local";
}

/** The newest of the server's record (from the encrypted list) and this device's record. */
export function effectiveSend(job: Pick<SiteJob, "submission">, local?: LocalSend): EffectiveSend | undefined {
  const server = job.submission
    ? { state: job.submission.state as SendState, detail: job.submission.detail, at: job.submission.updatedAt, source: "server" as const }
    : undefined;
  const mine = local ? { state: local.state, detail: local.detail, at: local.at, source: "local" as const } : undefined;
  if (server && mine) return mine.at > server.at ? mine : server;
  return server ?? mine;
}

/** Already queued/sent/accepted jobs can't be re-selected; failed ones can be retried. */
export const isSelectable = (send?: EffectiveSend): boolean => !send || send.state === "failed";

export const sendLabel: Record<SendState, string> = { queued: "Queued", sent: "Sent", accepted: "Accepted", failed: "Failed" };

// ---------- route (a): GitHub Action ----------

export class DispatchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

/**
 * Starts ONE fitto-tnc run with all selected opaque ids. Workflow inputs are public on a public repo,
 * so only ids are sent, never URLs or titles. The token goes only to api.github.com.
 */
export async function dispatchToAction(ids: string[], opts: { token: string; repo?: string; fetchImpl?: typeof fetch }): Promise<void> {
  if (!opts.token) throw new DispatchError("Add a GitHub token in Settings first.");
  if (!ids.length) throw new DispatchError("Select at least one job.");
  if (ids.length > MAX_SELECTED) throw new DispatchError(`Select at most ${MAX_SELECTED} jobs per send.`);
  if (!ids.every((id) => ID_RE.test(id))) throw new DispatchError("Invalid job id.");
  const repo = opts.repo ?? DEFAULT_REPO;
  const f = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  let res: Response;
  try {
    res = await f(`https://api.github.com/repos/${repo}/actions/workflows/fitto-tnc.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { ids: ids.join(",") } }),
    });
  } catch {
    throw new DispatchError("Couldn't reach GitHub. Check your connection.");
  }
  if (res.status === 204 || res.status === 200) return;
  const why: Record<number, string> = {
    401: "GitHub rejected the token (expired or wrong).",
    403: "The token can't run workflows. It needs Actions: Read and write on the fitto repository.",
    404: "Workflow not found, or the token has no access to the fitto repository.",
    422: "GitHub rejected the request (is fitto-tnc.yml on main?).",
  };
  throw new DispatchError(why[res.status] ?? `GitHub returned HTTP ${res.status}.`, res.status);
}

// ---------- route (b): Direct API from the browser ----------

export interface DirectOptions {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  maxPolls?: number;
  onProgress?: (id: string, result: SubmissionResult, index: number, total: number) => void;
}

/**
 * Posts each selected job URL straight to The Next Chapter, one at a time, with the same Idempotency-Key
 * formula and polling rules as the workflow (shared TncSink). If the very first request is blocked by CORS
 * this throws CorsBlockedError so the caller can offer the GitHub Action route instead.
 */
export async function sendDirect(jobs: Pick<SiteJob, "id" | "url">[], opts: DirectOptions): Promise<Record<string, SubmissionResult>> {
  if (!opts.token) throw new Error("Add a The Next Chapter token in Settings first.");
  if (jobs.length > MAX_SELECTED) throw new Error(`Select at most ${MAX_SELECTED} jobs per send.`);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sink = new TncSink({ token: opts.token, fetchImpl: opts.fetchImpl, sleep, baseUrl: opts.baseUrl, maxPolls: opts.maxPolls ?? 6, browser: true });
  const out: Record<string, SubmissionResult> = {};
  for (const [i, job] of jobs.entries()) {
    if (i > 0) await sleep(SEND_GAP_MS);
    let res: SubmissionResult;
    try {
      res = await sink.submit(job.url);
    } catch (e) {
      if (e instanceof CorsBlockedError && i === 0) throw e;
      res = { state: "failed", detail: "network" };
    }
    out[job.id] = res;
    opts.onProgress?.(job.id, res, i, jobs.length);
  }
  return out;
}
