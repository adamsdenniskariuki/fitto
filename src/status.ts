import { FEEDBACK, STATUSES, type Feedback, type State, type Status } from "./state.js";

export const STATUS_VALUES = [...STATUSES, ...FEEDBACK] as const;
export type StatusValue = Status | Feedback;

export function parseIds(raw: string): string[] {
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const id of ids) if (!/^[0-9a-f]{6,64}$/.test(id)) throw new Error("job ids must be hex ids from the digest");
  return ids;
}

/** Apply a status or thumbs value to jobs. Returns the number updated; unknown ids are counted, not echoed. */
export function applyStatus(state: State, ids: string[], value: string, now = new Date()): { updated: number; unknown: number } {
  if (!(STATUS_VALUES as readonly string[]).includes(value)) {
    throw new Error(`status must be one of: ${STATUS_VALUES.join(", ")}`);
  }
  const at = now.toISOString();
  let updated = 0;
  let unknown = 0;
  for (const id of ids) {
    const r = state.jobs[id];
    if (!r) {
      unknown++;
      continue;
    }
    if ((FEEDBACK as readonly string[]).includes(value)) {
      r.feedback = value as Feedback;
      r.feedbackAt = at;
    } else {
      r.status = value as Status;
      r.statusUpdatedAt = at;
    }
    r.history.push({ at, status: value as StatusValue });
    updated++;
  }
  return { updated, unknown };
}
