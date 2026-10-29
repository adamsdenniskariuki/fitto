# Fitto

Fitto is a daily agent that finds and scores jobs that fit you. It runs on GitHub Actions in this public repository, and none of your personal data is ever committed or published.

> 🚧 Under construction: step 1 of 6 (scaffold and job fetching). Full docs land with later steps.

## Quick start (local)

```sh
pnpm install
pnpm fitto fetch      # fetch + normalise + dedupe; prints per-source counts only
pnpm check            # lint + typecheck + tests
```

## Sources

Fitto uses public job feeds only, sends a clear User-Agent, respects `robots.txt` and rate limits itself per host. It never scrapes LinkedIn or Indeed.

| Source | Endpoint | Notes |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/<slug>/jobs` | Public job board API |
| Lever | `api.lever.co/v0/postings/<slug>` | Public postings API |
| Ashby | `api.ashbyhq.com/posting-api/job-board/<slug>` | Public posting API |
| Workable | `apply.workable.com/api/v1/widget/accounts/<slug>` | Public widget API |
| We Work Remotely | `weworkremotely.com/categories/<feed>.rss` | RSS, credited in the digest |
| Remote OK | `remoteok.com/api` | Credited with a link back, as its terms require |
| HN "Who is hiring?" | `hn.algolia.com/api/v1` | Latest monthly thread |
| Remotive | `remotive.com/api/remote-jobs` | Off by default: its `robots.txt` currently disallows `/api` |

Edit `companies.yaml` to choose companies, or set the `FITTO_COMPANIES` secret to keep your watchlist private.
