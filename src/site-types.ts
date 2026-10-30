/** Shared by the exporter (Node) and the site (browser). Keep this file free of imports. */

export interface SiteJob {
  id: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  salary: string;
  url: string;
  source: string;
  attribution?: string;
  postedAt?: string;
  firstSeen: string;
  score: number;
  final: number;
  confidence: string;
  fit_summary: string;
  matched_skills: string[];
  gaps: string[];
  red_flags: string[];
  adjustReasons: string[];
  status: string;
  draft?: { cv_bullets: string[]; cover_note: string; provider: string };
  devprep?: string;
  submission?: { state: string; detail: string; updatedAt: string };
}

export interface SitePayload {
  v: 1;
  generatedAt: string;
  repo: string;
  jobs: SiteJob[];
}

export interface SiteEnvelope {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iter: number;
  alg: "AES-256-GCM";
  salt: string;
  iv: string;
  /** Base64 of ciphertext followed by the 16-byte GCM tag (the layout WebCrypto expects). */
  ct: string;
}
