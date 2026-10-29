export type SalaryPeriod = "year" | "month" | "hour";

export interface Salary {
  min?: number;
  max?: number;
  currency?: string;
  period?: SalaryPeriod;
}

export interface Job {
  /** Stable opaque id (keyed hash of source + sourceId). */
  id: string;
  source: string;
  sourceId: string;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  url: string;
  /** Plain text, truncated. */
  description: string;
  postedAt?: string;
  salary?: Salary;
  tags: string[];
  /** Attribution required by some feeds (e.g. RemoteOK, Remotive). */
  attribution?: string;
}

/** A job before the id has been assigned. */
export type RawJob = Omit<Job, "id">;
