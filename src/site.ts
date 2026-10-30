import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { devprepLink } from "./devprep.js";
import { formatSalary, safeUrl } from "./digest.js";
import type { SiteEnvelope, SiteJob, SitePayload } from "./site-types.js";
import type { State } from "./state.js";

export type { SiteEnvelope, SiteJob, SitePayload };

/**
 * Encrypted job list for the Fitto site. The workflow encrypts it with FITTO_SITE_PASSPHRASE and
 * publishes only the ciphertext; the browser decrypts it locally with WebCrypto (site/src/core.ts).
 */

export const SITE_KDF_ITERATIONS = 600_000;
export const SITE_MAX_JOBS = 200;
const HIDDEN = ["no", "rejected"];

export function buildSitePayload(state: State, opts: { minScore: number; repo: string; now?: Date }): SitePayload {
  const jobs = Object.values(state.jobs)
    .filter((r) => r.score && (r.score.final >= opts.minScore || state.submissions[r.job.id]) && !HIDDEN.includes(r.status))
    .sort((a, b) => b.score!.final - a.score!.final)
    .slice(0, SITE_MAX_JOBS)
    .map((r): SiteJob => {
      const s = r.score!;
      const d = state.drafts[r.job.id];
      const sub = state.submissions[r.job.id];
      return {
        id: r.job.id,
        title: r.job.title,
        company: r.job.company,
        location: r.job.location,
        remote: r.job.remote,
        salary: formatSalary(r.job),
        url: safeUrl(r.job.url),
        source: r.job.source,
        attribution: r.job.attribution,
        postedAt: r.job.postedAt,
        firstSeen: r.firstSeen,
        score: s.score,
        final: s.final,
        confidence: s.confidence,
        fit_summary: s.fit_summary,
        matched_skills: s.matched_skills,
        gaps: s.gaps,
        red_flags: s.red_flags,
        adjustReasons: s.adjustReasons ?? [],
        status: r.status,
        draft: d ? { cv_bullets: d.cv_bullets, cover_note: d.cover_note, provider: d.provider } : undefined,
        devprep: devprepLink(r.job.company),
        submission: sub ? { state: sub.state, detail: sub.detail, updatedAt: sub.updatedAt } : undefined,
      };
    });
  return { v: 1, generatedAt: (opts.now ?? new Date()).toISOString(), repo: opts.repo, jobs };
}

export function encryptForSite(payload: unknown, passphrase: string, iter = SITE_KDF_ITERATIONS): SiteEnvelope {
  if (passphrase.length < 12) throw new Error("FITTO_SITE_PASSPHRASE must be at least 12 characters");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase.normalize("NFC"), salt, iter, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iter,
    alg: "AES-256-GCM",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function writeSiteExport(path: string, envelope: SiteEnvelope): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(envelope));
}
