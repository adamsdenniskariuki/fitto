# Setting up Fitto

Fitto runs entirely in GitHub Actions in this public repository. Your profile, statuses, scores and drafts are stored only in **Actions secrets** and an **encrypted state file**, so nothing personal ever appears in the repo, logs or issues. Set secrets with `gh secret set` from your own terminal. Never paste them into chats, issues or commits.

All commands below assume `-R adamsdenniskariuki/fitto` (or run them inside a clone).

## 1. Create your profile (`FITTO_PROFILE`)

1. Copy the template and fill it in locally. `profile.yaml` is git-ignored.

   ```sh
   cp profile.example.yaml profile.yaml
   ```

   Key fields: `skills`, `nice_to_have`, `seniority`, `title_keywords`, `exclude_title_keywords`, `locations` (`remote`, `onsite_cities`, `countries`, `exclude` phrases such as "US only"), `salary.min`, `dealbreakers`, `digest.min_score` / `digest.top_n`, and `cv` (paste your CV as plain text; it is used for scoring and drafts).

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

## 4. Optional settings

| Name | Kind | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | secret | Use OpenAI instead of GitHub Models for scoring |
| `FITTO_COMPANIES` | secret | Private watchlist (same YAML as `companies.yaml`) that overrides the public file |
| `FITTO_MODEL` | variable | Model id, e.g. `openai/gpt-4.1-mini` (GitHub Models) or `gpt-4.1-mini` (OpenAI) |
| `FITTO_MAX_LLM_CALLS` | variable | Scoring calls per run (default 40) |
| `FITTO_MAX_DRAFTS` | variable | Draft CV bullets and cover notes per run for scores of 80 or more (default 3) |
| `FITTO_EMAIL_FROM` | variable | Sender address |

Set variables with `gh variable set NAME --body value`.

GitHub Models uses the workflow's built-in `GITHUB_TOKEN` (`models: read`), so it needs no extra secret. Free-tier rate limits apply, and Fitto stops scoring for the day when it hits them.

## 5. Run it

```sh
gh workflow run fitto.yml                   # daily run now (otherwise 05:00 UTC every day)
gh workflow run fitto.yml -f dry_run=true   # dry run: nothing is sent or saved
gh workflow run fitto-weekly.yml            # weekly summary now (otherwise Mondays)
```

## 6. Mark jobs (statuses and thumbs)

Every job in the digest has an opaque id (e.g. `1bdaa62bca`). It reveals nothing about the job and is safe to use publicly.

```sh
gh workflow run fitto-status.yml -f ids=1bdaa62bca -f status=applied
gh workflow run fitto-status.yml -f ids=1bdaa62bca,7f3e0c11aa -f status=no
gh workflow run fitto-status.yml -f ids=1bdaa62bca -f status=up      # thumbs up / down
```

You can also use the browser: open **Actions → fitto-status → Run workflow** (linked in every email), paste the id and pick a status. Note that the id and the chosen status are visible in the public Actions log, but the id cannot be linked to a job without your state key.

Statuses: `saved`, `applied`, `interview`, `offer`, `rejected`, `no` (hide it), `new`. Feedback: `up`, `down`.

A job reappears in the digest only if its status changes. Locally, with `FITTO_STATE_KEY` exported, you can run `pnpm fitto status <ids> <status>` and `pnpm fitto tracker`.

## Secrets checklist

| Secret | Required | |
|---|---|---|
| `FITTO_PROFILE` | yes | Your profile YAML |
| `FITTO_STATE_KEY` | yes | `pnpm fitto keygen` |
| `FITTO_EMAIL_TO` | yes, for email | Your address |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | one of these two | Gmail app password or other SMTP |
| `RESEND_API_KEY` | one of these two | Resend |
| `OPENAI_API_KEY` | no | Optional scorer |
| `FITTO_COMPANIES` | no | Private watchlist |
