# Setting up Fitto

Fitto runs entirely in GitHub Actions in this public repository. Your profile, statuses, scores and drafts are stored only in **Actions secrets** and an **encrypted state file**, so nothing personal ever appears in the repo, logs or issues. Set secrets with `gh secret set` from your own terminal. Never paste them into chats, issues or commits.

All commands below assume `-R adamsdenniskariuki/fitto` (or run them inside a clone).

> **Use repository secrets, not environment secrets.** In the web UI go to **Settings → Secrets and variables → Actions → Repository secrets → New repository secret**. Secrets added under **Environments → github-pages** are invisible to the Fitto workflows. `gh secret set NAME` (without `--env`) always creates a repository secret. Check with `gh secret list -R adamsdenniskariuki/fitto`.

## 1. Create your profile (`FITTO_PROFILE`)

1. Copy the template and fill it in locally. `profile.yaml` is git-ignored.

   ```sh
   cp profile.example.yaml profile.yaml
   ```

   Key fields: `skills`, `nice_to_have`, `seniority`, `title_keywords`, `exclude_title_keywords`, `locations` (`remote`, `onsite_cities`, `countries`, `exclude` phrases such as "US only"), `salary.min` (in `salary.currency`) plus optional `salary.floors` per other currency, e.g. `{ EUR: 55000, GBP: 47000 }`; salaries in currencies without a floor are not filtered, `dealbreakers`, `digest.min_score` / `digest.top_n`, and `cv` (paste your CV as plain text; it is used for scoring and drafts).

2. Check it locally with no secrets needed:

   ```sh
   pnpm install
   FITTO_DRY_RUN=1 FITTO_PROFILE_FILE=profile.yaml pnpm fitto run
   # open out/daily.html
   ```

3. Store it as a secret, then delete the local copy if you like:

   ```sh
   gh secret set FITTO_PROFILE < profile.yaml
   ```

## 2. Generate the state key (`FITTO_STATE_KEY`)

The state key encrypts everything Fitto remembers (AES-256-GCM). Keep a copy in your password manager: without it you can't read the tracker locally.

```sh
pnpm fitto keygen | gh secret set FITTO_STATE_KEY
# Or, without Node: openssl rand -base64 32 | gh secret set FITTO_STATE_KEY
```

To use `pnpm fitto tracker` / `status` locally, export the same value as `FITTO_STATE_KEY` in your shell.

## 3. Email delivery

Pick **one** provider. `FITTO_EMAIL_TO` is required for both.

```sh
gh secret set FITTO_EMAIL_TO      # your address
```

### Option A: Gmail (or any SMTP) with an app password

1. Turn on 2-Step Verification for your Google account.
2. Create an app password at <https://myaccount.google.com/apppasswords>. It is a 16-character code.
3. Set the secrets:

   ```sh
   gh secret set SMTP_HOST --body smtp.gmail.com
   gh secret set SMTP_PORT --body 465
   gh secret set SMTP_USER           # your Gmail address
   gh secret set SMTP_PASS           # the app password (prompted, not echoed)
   ```

### Option B: Resend

1. Create an API key at <https://resend.com/api-keys> with "Sending access".
2. Set it with `gh secret set RESEND_API_KEY`.
3. Without a verified domain, Resend only delivers to your own account address from `onboarding@resend.dev`. To send from your domain, verify it in Resend and set `gh variable set FITTO_EMAIL_FROM --body "Fitto <fitto@yourdomain>"`.

If no provider is configured, runs still work but only write a redacted (counts only) job summary.

## 4. LLM scoring (recommended)

Without an API key, Fitto uses a free keyword scorer: it works, but its scores are rough and it writes no "why it fits" summaries or drafts. Add **one** of these keys (both work; if both are set, OpenAI wins unless `FITTO_LLM=anthropic`).

### Option A: OpenAI (default)

1. Create a key at <https://platform.openai.com/api-keys> (name it `fitto`). Copy the whole `sk-…` value; it's shown only once.
2. Add prepaid credit under **Settings → Billing** ($5 lasts a long time) and, ideally, a monthly budget limit.
3. Store it, pasting the key at the prompt with no extra spaces:
   ```sh
   gh secret set OPENAI_API_KEY -R adamsdenniskariuki/fitto
   ```

Default model `gpt-4.1-mini`: a few cents a day at the default caps.

### Option B: Claude (Anthropic)

1. Create a key at <https://platform.claude.com> (**API keys**) and add prepaid credit under **Billing**.
2. Store it:
   ```sh
   gh secret set ANTHROPIC_API_KEY -R adamsdenniskariuki/fitto
   ```
3. If `OPENAI_API_KEY` is also set and you want Claude, choose it explicitly:
   ```sh
   gh variable set FITTO_LLM --body anthropic -R adamsdenniskariuki/fitto
   ```

Default model `claude-haiku-5-5` (cheaper than `gpt-4.1-mini`). For more careful judgements, `gh variable set FITTO_MODEL --body claude-sonnet-5-5` (roughly 20× the cost).

Each run scores at most `FITTO_MAX_LLM_CALLS` jobs (best keyword matches first) and defers the rest to the next run. Scores are cached, so a job is only scored once per profile; jobs scored earlier by the keyword scorer are rescored once a key is added. If the provider rate-limits a run, Fitto stops scoring and continues next time.

(GitHub Models, the former free default, was retired on 30 July 2026.)

## 5. Optional settings

| Name | Kind | Purpose |
|---|---|---|
| `FITTO_LLM` | variable | Force a provider: `openai`, `anthropic` or `heuristic` (keyword scorer) |
| `FITTO_MODEL` | variable | Model id, e.g. `gpt-4.1-mini` (OpenAI default), `claude-haiku-5-5` (Claude default) or `claude-sonnet-5-5`. Must match the provider in use |
| `FITTO_MAX_LLM_CALLS` | variable | Scoring calls per run (default 40) |
| `FITTO_MAX_DRAFTS` | variable | Draft CV bullets and cover notes per run for scores of 80 or more (default 3) |
| `FITTO_EMAIL_FROM` | variable | Sender address |
| `FITTO_COMPANIES` | secret | Private watchlist (same YAML as `companies.yaml`) that overrides the public file |

Set variables with `gh variable set NAME --body value -R adamsdenniskariuki/fitto`. Variables are public: never put personal data in them.

## 6. Run it

```sh
gh workflow run fitto.yml                   # daily run now (otherwise 05:00 UTC every day)
gh workflow run fitto.yml -f dry_run=true   # dry run: nothing is sent or saved
gh workflow run fitto-weekly.yml            # weekly summary now (otherwise Mondays)
```

## 7. Mark jobs (statuses and thumbs)

Every job in the digest has an opaque id (e.g. `1bdaa62bca`). It reveals nothing about the job and is safe to use publicly.

```sh
gh workflow run fitto-status.yml -f ids=1bdaa62bca -f status=applied
gh workflow run fitto-status.yml -f ids=1bdaa62bca,7f3e0c11aa -f status=no
gh workflow run fitto-status.yml -f ids=1bdaa62bca -f status=up      # thumbs up / down
```

You can also use the browser: open **Actions → fitto-status → Run workflow** (linked in every email), paste the id and pick a status. Note that the id and the chosen status are visible in the public Actions log, but the id cannot be linked to a job without your state key.

Statuses: `saved`, `applied`, `interview`, `offer`, `rejected`, `no` (hide it), `new`. Feedback: `up`, `down`.

A job reappears in the digest only if its status changes. Locally, with `FITTO_STATE_KEY` exported, you can run `pnpm fitto status <ids> <status>` and `pnpm fitto tracker`.

## 8. Send jobs to The Next Chapter (optional)

Fitto never sends anything on its own. Only the job ids you pass are sent.

1. Create an API token in your The Next Chapter account, then store it:
   ```sh
   gh secret set TNC_API_TOKEN -R adamsdenniskariuki/fitto      # paste when prompted
   ```
2. Send one or more jobs by id. They're processed one at a time, polling politely until TNC accepts or rejects each:
   ```sh
   gh workflow run fitto-tnc.yml -R adamsdenniskariuki/fitto -f ids=1bdaa62bca,7f3e0c11aa
   gh workflow run fitto-tnc.yml -R adamsdenniskariuki/fitto -f ids=1bdaa62bca -f dry_run=true   # test: sends nothing
   gh workflow run fitto-tnc.yml -R adamsdenniskariuki/fitto -f ids=refresh                      # re-check in-progress ones
   ```
3. Results (Sent, Accepted or Failed) are recorded in the encrypted state, and the log only shows `job 1/2: accepted`. Already-accepted jobs are skipped, and reruns reuse the same Idempotency-Key (a hash of the job URL), so TNC never receives duplicates.

If you rotate the TNC token, jobs still "in progress" can't be re-checked with the new token (TNC limitation). Send them again; the idempotency key prevents duplicates.

## 9. The site (fitto.madebyfavor.com)

The site is deployed by the `pages` workflow. It publishes public docs and one encrypted file with your matches.

1. **Set a site passphrase** (**at least 12 characters**, or the site deploy fails and publishes docs only; a long random one is best):
   ```sh
   pnpm fitto keygen   # copy this into your password manager first
   gh secret set FITTO_SITE_PASSPHRASE -R adamsdenniskariuki/fitto   # then paste it when prompted
   ```
   You'll type it on the site, so keep it in your password manager. Changing it re-encrypts the list on the next deploy.
2. **Optional:** add the site link to every email:
   ```sh
   gh variable set FITTO_SITE_URL --body https://fitto.madebyfavor.com/jobs.html -R adamsdenniskariuki/fitto
   ```
3. **Open https://fitto.madebyfavor.com/jobs.html** and enter the passphrase. Tick "Remember on this device" only on devices you trust.
4. **To send jobs to TNC from the site, using the GitHub Action route (default):** create a fine-grained token at <https://github.com/settings/personal-access-tokens/new>:
   - Resource owner: you. Repository access: **Only select repositories → fitto**.
   - Permissions: **Actions → Read and write**. Nothing else; Metadata (read) is added automatically.
   - Expiration: short (e.g. 30–90 days).

   Paste it in **My jobs → Settings**. It's stored only in this browser and sent only to `api.github.com`. Each send dispatches `fitto-tnc` with opaque ids, so `TNC_API_TOKEN` (section 8) must be set. Results appear on the site once the run finishes and Pages redeploys, usually within a few minutes.
5. **Direct API mode (optional):** in Settings choose "Direct API" and paste your TNC token. It's stored only in this browser and sent only to `thenextchapter.dev`. The browser then posts each selected URL itself, with the same Idempotency-Key and polling rules, and results are saved locally. **Today TNC doesn't allow browser requests (no CORS headers), so this is blocked**. The site shows "The Next Chapter doesn't allow browser requests yet — use GitHub Action mode" and offers a one-click switch. Nothing is sent when that happens.

   **Check whether Direct mode works yet, without submitting anything.** Open <https://fitto.madebyfavor.com/jobs.html> (not the home page, which blocks all outside connections), press F12 and run this in the Console. It sends no token, so TNC can't create a submission:
   ```js
   fetch("https://thenextchapter.dev/api/v1/submissions", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: "{}",
   }).then(r => console.log("CORS OK, status", r.status))
     .catch(e => console.log("Blocked by CORS:", e.message));
   ```
   "Blocked by CORS" means keep using GitHub Action mode. "CORS OK, status 401" means Direct mode will work. For TNC to allow it, its API must return these headers on `/api/v1/submissions` (OPTIONS and POST) and on the `statusUrl` endpoint (GET):
   ```
   Access-Control-Allow-Origin: https://fitto.madebyfavor.com
   Access-Control-Allow-Methods: POST, GET, OPTIONS
   Access-Control-Allow-Headers: authorization, content-type, idempotency-key
   ```

Pages settings (already done once by the maintainer): Settings → Pages → Source **GitHub Actions**, custom domain `fitto.madebyfavor.com`, **Enforce HTTPS** on.

## Secrets checklist

| Secret | Required | |
|---|---|---|
| `FITTO_PROFILE` | yes | Your profile YAML |
| `FITTO_STATE_KEY` | yes | `pnpm fitto keygen` |
| `FITTO_EMAIL_TO` | yes, for email | Your address |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | one of these two | Gmail app password or other SMTP |
| `RESEND_API_KEY` | one of these two | Resend |
| `OPENAI_API_KEY` | recommended | LLM scoring and drafts (OpenAI) |
| `ANTHROPIC_API_KEY` | no | LLM scoring and drafts (Claude), instead of or as well as OpenAI |
| `FITTO_COMPANIES` | no | Private watchlist |
| `TNC_API_TOKEN` | no | Only to send selected jobs to The Next Chapter |
| `FITTO_SITE_PASSPHRASE` | for the site | At least 12 characters; unlocks your encrypted job list on fitto.madebyfavor.com |

Tokens you paste into the site (a fine-grained GitHub token with Actions: Read and write on fitto only, and optionally a TNC token for Direct mode) are **not** repository secrets. They live only in your browser.

## Troubleshooting

Run logs show only aggregate counts. Find them under **Actions → fitto → latest run → daily → Run Fitto**.

| Symptom | Cause and fix |
|---|---|
| Run says "Dry run (… FITTO_PROFILE / FITTO_STATE_KEY not set)" | The secrets are missing or were added as **environment** secrets. Re-add them as repository secrets (see the note at the top). |
| `scoring (heuristic)` | No LLM key is set, so the keyword scorer is used. See section 4. |
| `failures: HTTP 401 (invalid_api_key)` or `(authentication_error)` | The API key is wrong, truncated or revoked. Create a new one and run `gh secret set` again. |
| `failures: HTTP 429 …` / `(rate limited)` / `insufficient_quota` | Out of credit or rate-limited. Add billing credit; deferred jobs are scored on later runs. |
| `failures: invalid response` or `schema mismatch (…)` | The model returned unusable output. Try another `FITTO_MODEL`, or unset it to use the default. |
| `no new matches today` | Nothing new scored at or above `digest.min_score` in your profile. Lower it, or wait for deferred jobs to be scored. |
| No email arrives | Check spam, the `daily: delivered … via email` log line, and the SMTP secrets (Gmail needs an app password, port `465`). |
| `pages` run fails: "FITTO_SITE_PASSPHRASE must be at least 12 characters" | Set a longer passphrase (section 9) and rerun `fitto` or `pages`. |
| Site says the passphrase is wrong | The list is encrypted with the passphrase from the last deploy. After changing it, wait for the next `pages` run to finish. |
| Direct mode: "doesn't allow browser requests yet" | Expected until TNC adds CORS headers. Use GitHub Action mode (section 9). |
