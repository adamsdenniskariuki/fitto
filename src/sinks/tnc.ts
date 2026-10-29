import { createHash } from "node:crypto";

/**
 * The Next Chapter (thenextchapter.dev) submission sink.
 *
 * API: POST {base}/api/v1/submissions with `{ url }`, a Bearer token and an Idempotency-Key.
 * A 202 returns a statusUrl to poll (>= 5 s apart, honouring Retry-After). One URL per POST.
 * This module never logs URLs, tokens or response bodies.
 */

export const TNC_BASE = "https://thenextchapter.dev";
export const MIN_POLL_MS = 5_000;

export type SubmissionState = "sent" | "accepted" | "failed";

export interface SubmissionResult {
  state: SubmissionState;
  /** Short machine-readable reason, e.g. "http-401", "processing", "completed". Never a URL. */
  detail: string;
  statusUrl?: string;
  httpStatus?: number;
}

/** A sink that hands one job posting URL to an external service. Never used without explicit user selection. */
export interface SubmissionSink {
  name: string;
  submit(url: string): Promise<SubmissionResult>;
  /** Re-check a submission that was still in progress. */
  refresh(statusUrl: string): Promise<SubmissionResult>;
}

/** Deterministic per-URL key, so retries and reruns never create duplicates. The site uses the same formula. */
export function idempotencyKey(url: string): string {
  return "fitto-" + createHash("sha256").update(url.trim()).digest("hex").slice(0, 32);
}

const ACCEPTED = new Set(["accepted", "completed", "complete", "succeeded", "success", "done", "processed", "created", "published"]);
const FAILED = new Set(["failed", "failure", "error", "rejected", "invalid", "cancelled", "canceled", "duplicate_rejected"]);

/** Map a TNC status payload to our states. Unknown values stay "sent" (still in progress). */
export function classify(body: unknown): { state: SubmissionState; detail: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = [b.status, b.state, (b.submission as Record<string, unknown> | undefined)?.status].find((v) => typeof v === "string");
  const status = typeof raw === "string" ? raw.toLowerCase().replace(/[^a-z_-]/g, "").slice(0, 32) : "";
  if (ACCEPTED.has(status)) return { state: "accepted", detail: status };
  if (FAILED.has(status)) return { state: "failed", detail: status };
  return { state: "sent", detail: status || "processing" };
}

/** Seconds or HTTP-date per RFC 9110; returns milliseconds or undefined. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export interface TncOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Status checks per submission before leaving it as "sent" for a later refresh. */
  maxPolls?: number;
  /** Retries of the POST on 429/5xx/network errors (same Idempotency-Key). */
  maxRetries?: number;
  /** Upper bound for any single wait, so a huge Retry-After can't stall the workflow. */
  maxWaitMs?: number;
}

export class TncSink implements SubmissionSink {
  readonly name = "the-next-chapter";
  private readonly base: URL;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxPolls: number;
  private readonly maxRetries: number;
  private readonly maxWaitMs: number;

  constructor(private readonly opts: TncOptions) {
    if (!opts.token) throw new Error("TNC_API_TOKEN is not set");
    this.base = new URL(opts.baseUrl ?? TNC_BASE);
    this.fetch = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxPolls = opts.maxPolls ?? 12;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxWaitMs = opts.maxWaitMs ?? 120_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.token}`, Accept: "application/json", "User-Agent": "fitto (+https://github.com/adamsdenniskariuki/fitto)", ...extra };
  }

  private wait(ms: number): Promise<void> {
    return this.sleep(Math.min(ms, this.maxWaitMs));
  }

  /** Only follow status URLs on the TNC origin, so the token is never sent elsewhere. */
  private resolveStatusUrl(raw: unknown): string | undefined {
    if (typeof raw !== "string" || !raw) return undefined;
    try {
      const u = new URL(raw, this.base);
      return u.origin === this.base.origin ? u.toString() : undefined;
    } catch {
      return undefined;
    }
  }

  async submit(url: string): Promise<SubmissionResult> {
    if (!/^https?:\/\//i.test(url)) return { state: "failed", detail: "invalid-url" };
    const endpoint = new URL("/api/v1/submissions", this.base).toString();
    const key = idempotencyKey(url);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(endpoint, {
          method: "POST",
          headers: this.headers({ "Content-Type": "application/json", "Idempotency-Key": key }),
          body: JSON.stringify({ url }),
        });
      } catch {
        if (attempt >= this.maxRetries) return { state: "failed", detail: "network" };
        await this.wait(2 ** attempt * 2000);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) return { state: "failed", detail: `http-${res.status}`, httpStatus: res.status };
        await this.wait(retryAfterMs(res.headers.get("retry-after")) ?? 2 ** attempt * 2000);
        continue;
      }
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) return { state: "failed", detail: `http-${res.status}`, httpStatus: res.status };
      const statusUrl = this.resolveStatusUrl((body as Record<string, unknown>).statusUrl ?? res.headers.get("location"));
      if (!statusUrl) {
        const c = classify(body);
        return { ...c, state: c.state === "failed" ? "failed" : res.status === 202 ? "sent" : "accepted", httpStatus: res.status };
      }
      return this.poll(statusUrl, Math.max(MIN_POLL_MS, retryAfterMs(res.headers.get("retry-after")) ?? 0));
    }
  }

  refresh(statusUrl: string): Promise<SubmissionResult> {
    const u = this.resolveStatusUrl(statusUrl);
    return u ? this.poll(u, 0, 1) : Promise.resolve({ state: "failed", detail: "bad-status-url" });
  }

  private async poll(statusUrl: string, initialWaitMs: number, polls = this.maxPolls): Promise<SubmissionResult> {
    let waitMs = initialWaitMs;
    let last: SubmissionResult = { state: "sent", detail: "processing", statusUrl };
    for (let i = 0; i < polls; i++) {
      if (waitMs) await this.wait(waitMs);
      let res: Response;
      try {
        res = await this.fetch(statusUrl, { headers: this.headers() });
      } catch {
        waitMs = MIN_POLL_MS;
        continue;
      }
      const ra = retryAfterMs(res.headers.get("retry-after"));
      waitMs = Math.max(MIN_POLL_MS, ra ?? 0);
      if (res.status === 429 || res.status >= 500) continue;
      if (res.status === 401 || res.status === 403) return { state: "sent", detail: `status-http-${res.status}`, statusUrl, httpStatus: res.status };
      if (res.status === 404) return { state: "sent", detail: "status-not-found", statusUrl, httpStatus: 404 };
      const body: unknown = await res.json().catch(() => ({}));
      const c = classify(body);
      last = { ...c, statusUrl, httpStatus: res.status };
      if (c.state !== "sent") return last;
    }
    return last;
  }
}

/** Records what would be submitted without calling the API. */
export class DryRunTncSink implements SubmissionSink {
  readonly name = "the-next-chapter (dry run)";
  submitted = 0;
  async submit(): Promise<SubmissionResult> {
    this.submitted++;
    return { state: "sent", detail: "dry-run" };
  }
  async refresh(): Promise<SubmissionResult> {
    return { state: "sent", detail: "dry-run" };
  }
}
