import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptJson,
  emptyState,
  encryptJson,
  FileStateStore,
  GitBranchStateStore,
  mergeStates,
  pruneState,
  saveState,
  StateConflictError,
  updateState,
  type JobRecord,
} from "../src/state.js";
import { finalize } from "../src/normalize.js";

const KEY = "test-key-0123456789abcdef";
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "fitto-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const rec = (id: string, over: Partial<JobRecord> = {}): JobRecord => ({
  job: { ...finalize({ source: "t", sourceId: id, company: "C", title: "T", location: "Remote", remote: true, url: "u", description: "d", tags: [] }), id },
  firstSeen: "2026-01-01T00:00:00.000Z",
  lastSeen: "2026-01-01T00:00:00.000Z",
  status: "new",
  history: [],
  ...over,
});

describe("encryption", () => {
  it("round-trips and hides plaintext", () => {
    const text = encryptJson({ secret: "my cv" }, KEY);
    expect(text).not.toContain("my cv");
    expect(decryptJson(text, KEY)).toEqual({ secret: "my cv" });
  });
  it("fails with the wrong key", () => {
    expect(() => decryptJson(encryptJson({ a: 1 }, KEY), KEY + "x")).toThrow(/wrong FITTO_STATE_KEY/);
  });
  it("rejects short keys", () => {
    expect(() => encryptJson({}, "short")).toThrow(/16 characters/);
  });
});

describe("FileStateStore", () => {
  it("detects concurrent writes and saveState merges", async () => {
    const store = new FileStateStore(join(tmp(), "s.enc"), KEY);
    const a = await store.load();
    expect(a.version).toBeNull();
    const s = emptyState();
    s.jobs.x = rec("x");
    await store.save(s, null);
    await expect(store.save(s, null)).rejects.toBeInstanceOf(StateConflictError);

    // A status update lands while a daily run holds an older copy.
    const daily = await store.load();
    await updateState(store, (st) => {
      st.jobs.x!.status = "applied";
      st.jobs.x!.statusUpdatedAt = "2026-01-02T00:00:00.000Z";
    });
    daily.state.jobs.y = rec("y");
    const saved = await saveState(store, daily.state, daily.version);
    expect(saved.jobs.x!.status).toBe("applied");
    expect(Object.keys((await store.load()).state.jobs).sort()).toEqual(["x", "y"]);
  });
});

describe("mergeStates", () => {
  it("keeps the latest user action per job", () => {
    const ours = emptyState();
    const theirs = emptyState();
    ours.jobs.a = rec("a", { status: "saved", statusUpdatedAt: "2026-01-03" });
    theirs.jobs.a = rec("a", { status: "no", statusUpdatedAt: "2026-01-02", feedback: "down", feedbackAt: "2026-01-02" });
    theirs.jobs.b = rec("b");
    theirs.learned = { auto: {}, manual: { "company:acme": 5 }, updatedAt: "2026-01-02" };
    const m = mergeStates(ours, theirs);
    expect(m.jobs.a!.status).toBe("saved");
    expect(m.jobs.a!.feedback).toBe("down");
    expect(m.jobs.b).toBeDefined();
    expect(m.learned.manual["company:acme"]).toBe(5);
  });
});

describe("pruneState", () => {
  it("drops stale untouched jobs but keeps tracked ones", () => {
    const s = emptyState();
    s.jobs.old = rec("old", { lastSeen: "2025-01-01T00:00:00Z" });
    s.jobs.applied = rec("applied", { lastSeen: "2025-01-01T00:00:00Z", status: "applied" });
    pruneState(s, Date.parse("2026-01-01T00:00:00Z"));
    expect(Object.keys(s.jobs)).toEqual(["applied"]);
  });
});

describe("GitBranchStateStore", () => {
  it("stores encrypted state on an orphan branch with lease protection", async () => {
    const root = tmp();
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    execFileSync("git", ["init", "--bare", "-q", remote]);
    execFileSync("git", ["init", "-q", work]);
    git(work, "remote", "add", "origin", remote);

    const store = new GitBranchStateStore(KEY, "fitto-state", "origin", "state.enc", work);
    const first = await store.load();
    expect(first.version).toBeNull();
    first.state.jobs.a = rec("a");
    const v1 = await store.save(first.state, null);

    const second = await store.load();
    expect(second.version).toBe(v1);
    expect(second.state.jobs.a).toBeDefined();
    const raw = git(work, "show", `${v1}:state.enc`).toString();
    expect(raw).not.toContain('"jobs"');

    await store.save(second.state, v1);
    await expect(store.save(second.state, v1)).rejects.toBeInstanceOf(StateConflictError);
  });
});
