import { XMLParser } from "fast-xml-parser";
import type { HttpClient } from "../http.js";
import { decodeEntities, htmlToText, isRemote, parseSalary } from "../normalize.js";
import type { RawJob } from "../types.js";

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

/** Remotive public API. ToS: link back to Remotive and credit it as the source; keep calls to a few per day. */
export async function fetchRemotive(http: HttpClient, category: string): Promise<RawJob[]> {
  const data = await http.json<{ jobs: RemotiveJob[] }>(
    `https://remotive.com/api/remote-jobs?category=${encodeURIComponent(category)}`,
  );
  return (data.jobs ?? []).map((j) => {
    const description = htmlToText(j.description);
    return {
      source: "remotive",
      sourceId: String(j.id),
      company: j.company_name,
      title: j.title,
      location: j.candidate_required_location ? `Remote (${j.candidate_required_location})` : "Remote",
      remote: true,
      url: j.url,
      description,
      postedAt: j.publication_date,
      salary: parseSalary(j.salary) ?? parseSalary(description),
      tags: [...(j.tags ?? []), j.job_type ?? ""],
      attribution: "Remotive (remotive.com)",
    };
  });
}

interface RemoteOkJob {
  id?: string | number;
  slug?: string;
  company?: string;
  position?: string;
  tags?: string[];
  location?: string;
  salary_min?: number;
  salary_max?: number;
  url?: string;
  apply_url?: string;
  date?: string;
  description?: string;
  legal?: string;
}

/** RemoteOK public API. ToS: link back to Remote OK and mention it as the source. */
export async function fetchRemoteOk(http: HttpClient): Promise<RawJob[]> {
  const data = await http.json<RemoteOkJob[]>("https://remoteok.com/api");
  return (data ?? [])
    .filter((j) => !j.legal && j.id && j.position && j.company)
    .map((j) => {
      const description = htmlToText(j.description);
      const hasSalary = (j.salary_min ?? 0) > 0 || (j.salary_max ?? 0) > 0;
      return {
        source: "remoteok",
        sourceId: String(j.id),
        company: j.company!,
        title: j.position!,
        location: j.location ? `Remote (${j.location})` : "Remote",
        remote: true,
        url: j.url ?? `https://remoteok.com/remote-jobs/${j.id}`,
        description,
        postedAt: j.date,
        salary: hasSalary
          ? { min: j.salary_min || undefined, max: j.salary_max || undefined, currency: "USD", period: "year" as const }
          : undefined,
        tags: j.tags ?? [],
        attribution: "Remote OK (remoteok.com)",
      };
    });
}

/** We Work Remotely category RSS feeds. */
export async function fetchWeWorkRemotely(http: HttpClient, feed: string): Promise<RawJob[]> {
  const xml = await http.text(`https://weworkremotely.com/categories/${encodeURIComponent(feed)}.rss`);
  return parseWwrRss(xml);
}

export function parseWwrRss(xml: string): RawJob[] {
  const parser = new XMLParser({ ignoreAttributes: true, processEntities: true });
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: unknown } } };
  const raw = doc.rss?.channel?.item;
  const items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[];
  return items.map((it) => {
    const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
    const fullTitle = decodeEntities(str(it.title));
    const idx = fullTitle.indexOf(":");
    const company = idx > 0 ? fullTitle.slice(0, idx).trim() : "Unknown";
    const title = idx > 0 ? fullTitle.slice(idx + 1).trim() : fullTitle;
    const description = htmlToText(str(it.description));
    const region = str(it.region);
    const link = str(it.link);
    const pub = str(it.pubDate);
    return {
      source: "weworkremotely",
      sourceId: str(it.guid) || link,
      company,
      title,
      location: region ? `Remote (${region})` : "Remote",
      remote: true,
      url: link,
      description,
      postedAt: pub ? new Date(pub).toISOString() : undefined,
      salary: parseSalary(description),
      tags: [str(it.category)].filter(Boolean),
      attribution: "We Work Remotely (weworkremotely.com)",
    };
  });
}

interface AlgoliaHit {
  objectID: string;
  title?: string;
  created_at?: string;
  comment_text?: string;
  parent_id?: number;
  story_id?: number;
}

const ROLE_RE =
  /\b(engineer|developer|architect|scientist|designer|manager|lead|sre|devops|analyst|programmer|cto|head of|director)\b/i;

export function parseHnComment(hit: AlgoliaHit): RawJob | undefined {
  const html = hit.comment_text ?? "";
  const firstLine = htmlToText(html.split(/<p>/i)[0] ?? "", 400);
  const parts = firstLine.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const company = parts[0]!.replace(/\(.*?\)/g, "").trim();
  const title = parts.slice(1).find((p) => ROLE_RE.test(p)) ?? parts[1]!;
  const location = parts.slice(1).filter((p) => p !== title).join(" | ");
  const description = htmlToText(html);
  return {
    source: "hn",
    sourceId: hit.objectID,
    company: company.slice(0, 80),
    title: title.slice(0, 160),
    location: location.slice(0, 200),
    remote: isRemote(firstLine),
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    description,
    postedAt: hit.created_at,
    salary: parseSalary(firstLine) ?? parseSalary(description),
    tags: [],
    attribution: "Hacker News 'Who is hiring?' (via Algolia HN API)",
  };
}

/** Latest "Ask HN: Who is hiring?" thread via the public Algolia HN API. */
export async function fetchHn(http: HttpClient, maxComments: number): Promise<RawJob[]> {
  const stories = await http.json<{ hits: AlgoliaHit[] }>(
    "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10",
  );
  const story = stories.hits.find((h) => /who is hiring/i.test(h.title ?? ""));
  if (!story) return [];
  const comments = await http.json<{ hits: AlgoliaHit[] }>(
    `https://hn.algolia.com/api/v1/search?tags=comment,story_${story.objectID}&hitsPerPage=${Math.min(maxComments, 1000)}`,
  );
  return comments.hits
    .filter((h) => String(h.parent_id) === story.objectID)
    .map(parseHnComment)
    .filter((j): j is RawJob => !!j);
}
