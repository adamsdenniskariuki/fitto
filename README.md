# Fitto

Fitto is a daily agent that finds and scores jobs that fit you. It runs on GitHub Actions in this public repository, and none of your personal data is ever committed or published.

> 🚧 Under construction: step 4 of 6 (fetching, scoring, email digests, feedback learning). See [SETUP.md](SETUP.md) to configure it. Full docs land with later steps.

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

## Scoring

1. **Hard filters** drop jobs that fail your title keywords, seniority, location/remote rules, salary floor (when the salary is known) or dealbreakers.
2. **Pre-rank** with a cheap keyword match, so the limited LLM budget goes to the most promising jobs.
3. **LLM score** 0–100 with structured JSON (fit summary, matched skills, gaps, red flags, confidence). The default is GitHub Models (`openai/gpt-4.1-mini`) through the workflow's `GITHUB_TOKEN` with `models: read`. Set `OPENAI_API_KEY` to use OpenAI instead, or `FITTO_LLM=heuristic` for the offline keyword scorer.
4. **Caps and cache:** at most `FITTO_MAX_LLM_CALLS` (default 40) calls per run. Results are cached by job content and profile hash, unscored jobs are deferred to the next run, and a rate limit stops scoring for the run.

Job descriptions are treated as untrusted input: the prompt tells the model to ignore any instructions inside a posting.

## State and privacy

All state (seen jobs, scores, statuses) is gzip-compressed JSON encrypted with AES-256-GCM, using a key derived via scrypt from the `FITTO_STATE_KEY` secret. It is stored as `state.enc` on the orphan `fitto-state` branch, one commit that is force-pushed with a lease; concurrent writers merge and retry. Workflow logs only print aggregate counts. Without `FITTO_PROFILE` and `FITTO_STATE_KEY` the workflow runs in dry-run mode.
## Digests and statuses

- **Daily email** (05:00 UTC) with the top `digest.top_n` jobs scoring at least `digest.min_score`. Each entry shows the title, company, location, salary, score, why it fits, gaps, red flags, the link (with source attribution), DevPREP interview prep for supported companies, and the status command. A job is never repeated unless its status changes.
- **Weekly email** (Mondays) with run counts, pipeline totals, status changes and the best new jobs.
- **Statuses**: `gh workflow run fitto-status.yml -f ids=<id> -f status=applied`, or run the **fitto-status** workflow from the Actions page. Ids are opaque keyed hashes.
- Delivery goes through the `src/sinks/` interface (`Sink.send(message)`). Email (SMTP or Resend) is built in, and other channels plug in the same way.

## Commands

| Command | What it does |
|---|---|
| `pnpm fitto run` | Daily run: fetch, filter, score, email the digest, save state |
| `pnpm fitto weekly [--force]` | Weekly summary |
| `pnpm fitto status <ids> <status>` | Set `saved`/`applied`/`interview`/`offer`/`rejected`/`no`/`new` or `up`/`down` |
| `pnpm fitto tracker [--all]` | Decrypt the state and print your tracker (local only; refuses to run in Actions) |
| `pnpm fitto learned [show|set <feature> <points>|unset <feature>|reset]` | Show or edit learned boosts and penalties (local only) |
| `pnpm fitto fetch` | Fetch only; per-source counts |
| `pnpm fitto eval` | Golden-set check against the configured scorer |
| `pnpm fitto keygen` | Random key for `FITTO_STATE_KEY` |
## Feedback learning

Thumbs (`up`/`down`) and statuses become signals: `up`, `applied`, `interview` and `offer` count +1, `saved` +0.5, and `down` and `no` −1. Employer rejections are neutral. Each job contributes features: `company:<name>`, `title:<word>` and `skill:<matched skill>`. A feature's weight is its smoothed average signal (capped at ±8 points), and a job's total adjustment is capped at ±15. Your most recent liked and disliked jobs are also passed to the LLM as few-shot examples.

Everything is transparent: digests show `Learned: +5 from your feedback (company:acme +3.3, …)`, and `pnpm fitto learned` prints every weight and example. Use `pnpm fitto learned set skill:go 6` to pin a weight. Manual values override learned ones, and `unset` or `reset` removes them.