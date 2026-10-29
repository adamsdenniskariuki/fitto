/** Minimal robots.txt evaluation (longest-match, Allow wins ties). */
export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

export function parseRobots(text: string, agent: string): RobotsRules {
  const agentLc = agent.toLowerCase();
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" && value) current.allow.push(value);
    if (key === "disallow" && value) current.disallow.push(value);
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agentLc.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
  };
}

function matches(pattern: string, path: string): number {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    "^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""),
  );
  return re.test(path) ? body.length : -1;
}

export function isAllowed(rules: RobotsRules, path: string): boolean {
  let best = -1;
  let allowed = true;
  for (const p of rules.disallow) {
    const m = matches(p, path);
    if (m > best) {
      best = m;
      allowed = false;
    }
  }
  for (const p of rules.allow) {
    const m = matches(p, path);
    if (m >= best && m !== -1) {
      best = m;
      allowed = true;
    }
  }
  return allowed;
}
