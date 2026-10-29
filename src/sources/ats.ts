import type { HttpClient } from "../http.js";
import { htmlToText, isRemote, parseSalary } from "../normalize.js";
import type { RawJob, Salary } from "../types.js";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  location?: { name?: string };
  content?: string;
  departments?: { name: string }[];
}

export async function fetchGreenhouse(http: HttpClient, slug: string, company: string): Promise<RawJob[]> {
  const data = await http.json<{ jobs: GreenhouseJob[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
  );
  return (data.jobs ?? []).map((j) => {
    const description = htmlToText(j.content);
    const location = j.location?.name ?? "";
    return {
      source: "greenhouse",
      sourceId: `${slug}/${j.id}`,
      company,
      title: j.title,
      location,
      remote: isRemote(location, j.title),
      url: j.absolute_url,
      description,
      postedAt: j.first_published ?? j.updated_at,
      salary: parseSalary(description),
      tags: (j.departments ?? []).map((d) => d.name),
    };
  });
}

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  descriptionPlain?: string;
  additionalPlain?: string;
  lists?: { text: string; content: string }[];
  workplaceType?: string;
  categories?: { location?: string; commitment?: string; team?: string; allLocations?: string[] };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

function leverSalary(s: LeverPosting["salaryRange"]): Salary | undefined {
  if (!s || (s.min === undefined && s.max === undefined)) return undefined;
  const interval = s.interval ?? "";
  const period = /hour/i.test(interval) ? "hour" : /month/i.test(interval) ? "month" : "year";
  return { min: s.min, max: s.max, currency: s.currency, period };
}

export async function fetchLever(http: HttpClient, slug: string, company: string): Promise<RawJob[]> {
  const data = await http.json<LeverPosting[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  return (data ?? []).map((p) => {
    const lists = (p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join("\n");
    const description = [p.descriptionPlain, lists, p.additionalPlain].filter(Boolean).join("\n\n").slice(0, 6000);
    const location = p.categories?.location ?? p.categories?.allLocations?.join(", ") ?? "";
    return {
      source: "lever",
      sourceId: `${slug}/${p.id}`,
      company,
      title: p.text,
      location,
      remote: p.workplaceType === "remote" || isRemote(location),
      url: p.hostedUrl,
      description,
      postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : undefined,
      salary: leverSalary(p.salaryRange) ?? parseSalary(description),
      tags: [p.categories?.team, p.categories?.commitment].filter((t): t is string => !!t),
    };
  });
}

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl: string;
  publishedAt?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  department?: string;
  employmentType?: string;
  isListed?: boolean;
  compensation?: {
    summaryComponents?: {
      compensationType?: string;
      interval?: string;
      currencyCode?: string;
      minValue?: number;
      maxValue?: number;
    }[];
  };
}

export async function fetchAshby(http: HttpClient, slug: string, company: string): Promise<RawJob[]> {
  const data = await http.json<{ jobs: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
  );
  return (data.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const comp = j.compensation?.summaryComponents?.find((c) => /salary/i.test(c.compensationType ?? ""));
      const salary: Salary | undefined = comp
        ? {
            min: comp.minValue,
            max: comp.maxValue,
            currency: comp.currencyCode,
            period: /hour/i.test(comp.interval ?? "") ? "hour" : /month/i.test(comp.interval ?? "") ? "month" : "year",
          }
        : undefined;
      const location = [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean).join(", ");
      const description = j.descriptionPlain?.trim() ? j.descriptionPlain.slice(0, 6000) : htmlToText(j.descriptionHtml);
      return {
        source: "ashby",
        sourceId: `${slug}/${j.id}`,
        company,
        title: j.title,
        location,
        remote: j.isRemote === true || /remote/i.test(j.workplaceType ?? "") || isRemote(location),
        url: j.jobUrl,
        description,
        postedAt: j.publishedAt,
        salary: salary ?? parseSalary(description),
        tags: [j.department, j.employmentType].filter((t): t is string => !!t),
      };
    });
}

interface WorkableJob {
  title: string;
  shortcode: string;
  url: string;
  city?: string;
  state?: string;
  country?: string;
  telecommuting?: boolean;
  published_on?: string;
  created_at?: string;
  description?: string;
  department?: string;
  employment_type?: string;
}

export async function fetchWorkable(http: HttpClient, slug: string, company: string): Promise<RawJob[]> {
  const data = await http.json<{ name?: string; jobs: WorkableJob[] }>(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
  );
  return (data.jobs ?? []).map((j) => {
    const location = [j.city, j.state, j.country].filter(Boolean).join(", ");
    const description = htmlToText(j.description);
    return {
      source: "workable",
      sourceId: `${slug}/${j.shortcode}`,
      company,
      title: j.title,
      location,
      remote: j.telecommuting === true || isRemote(location),
      url: j.url,
      description,
      postedAt: j.published_on ?? j.created_at,
      salary: parseSalary(description),
      tags: [j.department, j.employment_type].filter((t): t is string => !!t),
    };
  });
}
