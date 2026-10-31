import type { Profile } from "./config.js";
import type { Job } from "./types.js";

/** Built-in place names for common regions; any other priority entry is matched literally. */
export const REGIONS: Record<string, string[]> = {
  kenya: ["kenya", "nairobi", "mombasa", "kisumu"],
  africa: ["africa", "kenya", "nairobi", "nigeria", "lagos", "ghana", "accra", "south africa", "cape town", "johannesburg", "egypt", "cairo", "rwanda", "kigali", "uganda", "kampala", "tanzania", "ethiopia", "morocco"],
  europe: [
    "europe", "emea", "eu", "european union", "uk", "united kingdom", "england", "london", "ireland", "dublin",
    "germany", "berlin", "munich", "france", "paris", "netherlands", "amsterdam", "spain", "madrid", "barcelona",
    "portugal", "lisbon", "italy", "milan", "poland", "warsaw", "sweden", "stockholm", "denmark", "copenhagen",
    "norway", "oslo", "finland", "helsinki", "switzerland", "zurich", "austria", "vienna", "belgium", "brussels",
    "czech", "prague", "romania", "estonia", "lithuania", "greece", "hungary", "cet", "cest",
  ],
  "middle east": [
    "middle east", "mena", "uae", "united arab emirates", "dubai", "abu dhabi", "saudi", "riyadh", "jeddah",
    "qatar", "doha", "bahrain", "kuwait", "oman", "muscat", "israel", "tel aviv", "jordan", "amman", "turkey", "istanbul",
  ],
  usa: [
    "usa", "us", "u.s.", "united states", "north america", "new york", "nyc", "san francisco", "seattle", "austin",
    "boston", "chicago", "los angeles", "denver", "atlanta", "miami", "washington", "est", "pst", "cst",
  ],
};
REGIONS.us = REGIONS.usa!;
REGIONS["united states"] = REGIONS.usa!;
REGIONS.emea = REGIONS.europe!;

const ALIASES: Record<string, string> = { eu: "europe", mena: "middle east", "middle-east": "middle east" };

function termsFor(entry: string): string[] {
  const key = entry.trim().toLowerCase();
  return REGIONS[ALIASES[key] ?? key] ?? [key];
}

function matches(location: string, term: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${esc}($|[^a-z])`, "i").test(location);
}

/** Index of the first `locations.priority` entry the job's location matches, or -1. */
export function regionRank(job: Job, profile: Profile): number {
  const list = profile.locations.priority;
  const where = job.location ?? "";
  return list.findIndex((entry) => termsFor(entry).some((t) => matches(where, t)));
}

/** Bonus points: the top region gets `priority_boost`, decreasing evenly down the list; unmatched jobs get 0. */
export function regionBoost(job: Job, profile: Profile): { points: number; region?: string } {
  const i = regionRank(job, profile);
  if (i < 0) return { points: 0 };
  const n = profile.locations.priority.length;
  return { points: Math.round((profile.locations.priority_boost * (n - i)) / n), region: profile.locations.priority[i] };
}
