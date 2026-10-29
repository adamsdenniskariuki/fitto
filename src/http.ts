import { isAllowed, parseRobots, type RobotsRules } from "./robots.js";

export const USER_AGENT =
  "Fitto/0.1 (+https://github.com/adamsdenniskariuki/fitto; personal job-search agent; polite, once daily)";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`HTTP ${status} for ${new URL(url).host}${new URL(url).pathname}`);
  }
}

export class RobotsDisallowedError extends Error {}

export interface HttpOptions {
  /** Minimum delay between requests to the same host (ms). */
  minIntervalMs?: number;
  timeoutMs?: number;
  retries?: number;
  respectRobots?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polite HTTP client: clear User-Agent, per-host rate limit, robots.txt, retries with backoff. */
export class HttpClient {
  private readonly lastHit = new Map<string, number>();
  private readonly robots = new Map<string, Promise<RobotsRules>>();
  private readonly opts: Required<HttpOptions>;

  constructor(opts: HttpOptions = {}) {
    this.opts = {
      minIntervalMs: opts.minIntervalMs ?? 1000,
      timeoutMs: opts.timeoutMs ?? 20_000,
      retries: opts.retries ?? 2,
      respectRobots: opts.respectRobots ?? true,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleep: opts.sleep ?? defaultSleep,
    };
  }

  private async throttle(host: string): Promise<void> {
    const last = this.lastHit.get(host) ?? 0;
    const wait = last + this.opts.minIntervalMs - Date.now();
    this.lastHit.set(host, Math.max(Date.now(), last + this.opts.minIntervalMs));
    if (wait > 0) await this.opts.sleep(wait);
  }

  private robotsFor(origin: string): Promise<RobotsRules> {
    let p = this.robots.get(origin);
    if (!p) {
      p = (async () => {
        try {
          const res = await this.opts.fetchImpl(`${origin}/robots.txt`, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(this.opts.timeoutMs),
          });
          if (!res.ok) return { allow: [], disallow: [] };
          return parseRobots(await res.text(), "fitto");
        } catch {
          return { allow: [], disallow: [] };
        }
      })();
      this.robots.set(origin, p);
    }
    return p;
  }

  async request(url: string, accept = "application/json"): Promise<Response> {
    const u = new URL(url);
    if (this.opts.respectRobots) {
      const rules = await this.robotsFor(u.origin);
      if (!isAllowed(rules, u.pathname + u.search)) {
        throw new RobotsDisallowedError(`robots.txt disallows ${u.host}${u.pathname}`);
      }
    }
    let attempt = 0;
    for (;;) {
      await this.throttle(u.host);
      let res: Response | undefined;
      let err: unknown;
      try {
        res = await this.opts.fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, Accept: accept },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (e) {
        err = e;
      }
      if (res?.ok) return res;
      const retryable = !res || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.opts.retries) {
        if (res) throw new HttpError(res.status, url);
        throw err instanceof Error ? err : new Error(String(err));
      }
      const retryAfter = Number(res?.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await this.opts.sleep(Math.min(backoff, 30_000));
      attempt++;
    }
  }

  async json<T = unknown>(url: string): Promise<T> {
    const res = await this.request(url);
    return (await res.json()) as T;
  }

  async text(url: string, accept = "application/rss+xml, application/xml, text/xml, */*"): Promise<string> {
    const res = await this.request(url, accept);
    return res.text();
  }
}
