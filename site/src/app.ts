/**
 * Fitto jobs page. Decrypts the published list in the browser and renders it with textContent only.
 * The passphrase and tokens stay on this device; tokens are sent only to the API they belong to.
 */
import {
  CorsBlockedError,
  decryptEnvelope,
  dispatchToAction,
  effectiveSend,
  isSelectable,
  LOCAL_STATUSES,
  MAX_SELECTED,
  sendDirect,
  sendLabel,
  SiteStore,
  WrongPassphraseError,
  type LocalStatus,
  type SendMode,
  type SiteEnvelope,
  type SiteJob,
  type SitePayload,
} from "./core.js";

const store = new SiteStore(localStorage, sessionStorage);
const selected = new Set<string>();
let payload: SitePayload | undefined;
let busy = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
};

type Child = Node | string | false | undefined;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | boolean> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") e.textContent = String(v);
    else if (k === "class") e.className = String(v);
    else if (typeof v === "boolean") {
      if (v) e.setAttribute(k, "");
    } else e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

const safeHref = (u?: string): string | undefined => (u && /^https:\/\//i.test(u) ? u : undefined);
const extLink = (href: string | undefined, text: string, cls = ""): HTMLElement =>
  href ? el("a", { href, text, target: "_blank", rel: "noopener noreferrer", class: cls }) : el("span", { text });

function notice(kind: "info" | "ok" | "error", ...content: Child[]): void {
  const n = $("notice");
  n.replaceChildren(...content.filter((c): c is Node | string => !!c));
  n.className = `notice notice-${kind}`;
  n.hidden = content.length === 0;
}

// ---------- unlock ----------

async function fetchEnvelope(): Promise<SiteEnvelope | undefined> {
  const res = await fetch("data/matches.enc.json", { cache: "no-store" });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Couldn't load the encrypted list (HTTP ${res.status}).`);
  return (await res.json()) as SiteEnvelope;
}

async function unlock(passphrase: string, remember: boolean): Promise<boolean> {
  const err = $("unlock-error");
  err.textContent = "";
  const env = await fetchEnvelope();
  if (!env) {
    $("no-data").hidden = false;
    return false;
  }
  try {
    payload = await decryptEnvelope(env, passphrase);
  } catch (e) {
    if (e instanceof WrongPassphraseError) store.forgetSecret("passphrase");
    err.textContent = e instanceof Error ? e.message : "Couldn't unlock.";
    return false;
  }
  if (remember) store.setSecret("passphrase", passphrase, true);
  $("lock").hidden = true;
  $("app").hidden = false;
  $("generated").textContent = `Updated ${new Date(payload.generatedAt).toLocaleString()} · ${payload.jobs.length} jobs`;
  render();
  return true;
}

function lock(): void {
  payload = undefined;
  selected.clear();
  store.forgetSecret("passphrase");
  $("jobs").replaceChildren();
  $<HTMLInputElement>("passphrase").value = "";
  $("app").hidden = true;
  $("lock").hidden = false;
  notice("info");
}

// ---------- rendering ----------

function visible(): SiteJob[] {
  if (!payload) return [];
  const filter = $<HTMLSelectElement>("filter").value;
  const q = $<HTMLInputElement>("search").value.trim().toLowerCase();
  const statuses = store.statuses;
  return payload.jobs.filter((j) => {
    const s = statuses[j.id]?.status;
    if (filter === "active" && s === "dismissed") return false;
    if ((LOCAL_STATUSES as readonly string[]).includes(filter) && s !== filter) return false;
    if (filter === "sent" && !effectiveSend(j, store.sends[j.id])) return false;
    if (q && !`${j.title} ${j.company} ${j.location}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function chips(label: string, items: string[], cls: string): Child {
  if (!items.length) return false;
  return el("div", { class: "chips" }, el("span", { class: "chips-label", text: label }), ...items.map((t) => el("span", { class: `chip ${cls}`, text: t })));
}

function jobCard(j: SiteJob): HTMLElement {
  const local = store.statuses[j.id]?.status;
  const send = effectiveSend(j, store.sends[j.id]);
  const selectable = isSelectable(send);
  const box = el("input", { type: "checkbox", class: "select", "aria-label": `Select ${j.title} at ${j.company}` });
  box.checked = selected.has(j.id);
  box.disabled = !selectable || busy;
  box.addEventListener("change", () => {
    if (box.checked) {
      if (selected.size >= MAX_SELECTED) {
        box.checked = false;
        notice("error", `You can send at most ${MAX_SELECTED} jobs at once.`);
        return;
      }
      selected.add(j.id);
    } else selected.delete(j.id);
    updateSelection();
  });

  const statusButtons = LOCAL_STATUSES.map((s) => {
    const b = el("button", { type: "button", class: "btn btn-small", text: s === "dismissed" ? "Dismiss" : s[0]!.toUpperCase() + s.slice(1), "aria-pressed": String(local === s) });
    b.addEventListener("click", () => {
      store.setStatus(j.id, local === s ? undefined : (s as LocalStatus));
      render();
    });
    return b;
  });

  const draft =
    j.draft &&
    el(
      "details",
      { class: "draft" },
      el("summary", { text: `Draft CV bullets and cover note (${j.draft.provider === "template" ? "template" : "AI draft"}; review before using)` }),
      el("ul", {}, ...j.draft.cv_bullets.map((b) => el("li", { text: b }))),
      el("p", { class: "cover", text: j.draft.cover_note }),
    );

  return el(
    "li",
    { class: `job${local === "dismissed" ? " dismissed" : ""}`, "data-id": j.id },
    el(
      "div",
      { class: "job-head" },
      box,
      el("h3", {}, extLink(safeHref(j.url), j.title)),
      el("span", { class: `score score-${j.final >= 80 ? "high" : j.final >= 65 ? "mid" : "low"}`, text: String(j.final), title: `Score ${j.final} (model ${j.score}, confidence ${j.confidence})` }),
    ),
    el("p", { class: "meta", text: [j.company, j.location || (j.remote ? "Remote" : ""), j.salary, `via ${j.attribution || j.source}`].filter(Boolean).join(" · ") }),
    j.fit_summary && el("p", { class: "fit", text: j.fit_summary }),
    chips("Matches", j.matched_skills, "chip-ok"),
    chips("Gaps", j.gaps, "chip-warn"),
    chips("Red flags", j.red_flags, "chip-bad"),
    chips("Adjusted", j.adjustReasons, ""),
    draft,
    el(
      "div",
      { class: "job-actions" },
      ...statusButtons,
      j.devprep && extLink(safeHref(j.devprep), "DevPREP company prep", "btn btn-small btn-ghost"),
      send && el("span", { class: `send send-${send.state}`, text: `${sendLabel[send.state]} to The Next Chapter${send.detail ? ` (${send.detail})` : ""}` }),
    ),
  );
}

function render(): void {
  if (!payload) return;
  const jobs = visible();
  $("jobs").replaceChildren(...(jobs.length ? jobs.map(jobCard) : [el("li", { class: "empty", text: "No jobs match this view." })]));
  updateSelection();
}

function updateSelection(): void {
  const n = selected.size;
  $("sel-count").textContent = `${n} selected`;
  $<HTMLButtonElement>("send-btn").disabled = n === 0 || busy;
  $<HTMLButtonElement>("clear-sel").disabled = n === 0 || busy;
  $<HTMLButtonElement>("select-all").disabled = busy;
}

function selectAllVisible(): void {
  for (const j of visible()) {
    if (selected.size >= MAX_SELECTED) break;
    if (isSelectable(effectiveSend(j, store.sends[j.id]))) selected.add(j.id);
  }
  render();
}

// ---------- sending ----------

function openSettings(message: string): void {
  const d = $<HTMLDetailsElement>("settings");
  d.open = true;
  $("settings-msg").textContent = message;
  d.scrollIntoView({ behavior: "smooth" });
}

const actionsUrl = (): string => `https://github.com/${store.settings.repo}/actions/workflows/fitto-tnc.yml`;

async function sendViaAction(ids: string[]): Promise<void> {
  const token = store.getSecret("ghToken");
  if (!token) {
    notice("error", "GitHub Action mode needs a fine-grained GitHub token. Add it in Settings.");
    openSettings("Paste a fine-grained token with Actions: Read and write on the fitto repository only.");
    return;
  }
  notice("info", `Starting one GitHub Action run for ${ids.length} job(s)…`);
  try {
    await dispatchToAction(ids, { token, repo: store.settings.repo });
  } catch (e) {
    notice("error", e instanceof Error ? e.message : "Couldn't start the workflow.");
    return;
  }
  const at = new Date().toISOString();
  for (const id of ids) store.setSend(id, { state: "queued", detail: "workflow started", at, via: "action" });
  selected.clear();
  notice(
    "ok",
    `Started one run for ${ids.length} job(s). Results show here as Sent, Accepted or Failed after the run finishes and the site refreshes (usually a few minutes). `,
    extLink(actionsUrl(), "Watch the run"),
  );
  render();
}

function corsFallback(ids: string[]): void {
  const btn = el("button", { type: "button", class: "btn btn-primary btn-small", text: `Switch to GitHub Action mode and send ${ids.length}` });
  btn.addEventListener("click", () => {
    store.saveSettings({ mode: "action" });
    syncSettingsForm();
    void withBusy(() => sendViaAction(ids));
  });
  notice("error", "The Next Chapter doesn't allow browser requests yet — use GitHub Action mode. Nothing was sent. ", btn);
}

async function sendViaDirect(ids: string[]): Promise<void> {
  const token = store.getSecret("tncToken");
  if (!token) {
    notice("error", "Direct mode needs your The Next Chapter token. Add it in Settings.");
    openSettings("Paste your The Next Chapter API token. It is stored on this device only.");
    return;
  }
  const byId = new Map(payload!.jobs.map((j) => [j.id, j]));
  const jobs = ids.map((id) => byId.get(id)).filter((j): j is SiteJob => !!j);
  notice("info", `Sending 1/${jobs.length} to The Next Chapter…`);
  try {
    const results = await sendDirect(jobs, {
      token,
      onProgress: (id, res, i, n) => {
        store.setSend(id, { state: res.state, detail: res.detail, at: new Date().toISOString(), via: "direct" });
        selected.delete(id);
        if (i + 1 < n) notice("info", `Sending ${i + 2}/${n} to The Next Chapter…`);
        render();
      },
    });
    const v = Object.values(results);
    const count = (s: string) => v.filter((r) => r.state === s).length;
    notice(count("failed") ? "error" : "ok", `Done: ${count("accepted")} accepted, ${count("sent")} sent (still processing), ${count("failed")} failed.`);
  } catch (e) {
    if (e instanceof CorsBlockedError) corsFallback(ids);
    else notice("error", e instanceof Error ? e.message : "Sending failed.");
  }
}

async function withBusy(fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    await fn();
  } finally {
    busy = false;
    render();
  }
}

function sendSelected(): void {
  const ids = [...selected];
  if (!ids.length || !payload) return;
  const mode = store.settings.mode;
  const how = mode === "direct" ? "directly from this browser (Direct API)" : "via one GitHub Action run";
  if (!confirm(`Send ${ids.length} selected job${ids.length === 1 ? "" : "s"} to The Next Chapter ${how}?\n\nOnly the jobs you selected are sent.`)) return;
  void withBusy(() => (mode === "direct" ? sendViaDirect(ids) : sendViaAction(ids)));
}

// ---------- settings & data ----------

function syncSettingsForm(): void {
  const s = store.settings;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) r.checked = r.value === s.mode;
  $<HTMLInputElement>("gh-remember").checked = store.isRemembered("ghToken");
  $<HTMLInputElement>("tnc-remember").checked = store.isRemembered("tncToken");
  $("gh-state").textContent = store.getSecret("ghToken") ? "Token set." : "No token set.";
  $("tnc-state").textContent = store.getSecret("tncToken") ? "Token set." : "No token set.";
}

function saveSettings(): void {
  const mode = (document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? "action") as SendMode;
  store.saveSettings({ mode });
  for (const [input, remember, name] of [
    ["gh-token", "gh-remember", "ghToken"],
    ["tnc-token", "tnc-remember", "tncToken"],
  ] as const) {
    const i = $<HTMLInputElement>(input);
    const keep = $<HTMLInputElement>(remember).checked;
    const value = i.value.trim() || store.getSecret(name);
    if (value) store.setSecret(name, value, keep);
    i.value = "";
  }
  syncSettingsForm();
  $("settings-msg").textContent = `Saved. Send mode: ${mode === "direct" ? "Direct API" : "GitHub Action"}.`;
}

function clearTokens(): void {
  store.forgetSecret("ghToken");
  store.forgetSecret("tncToken");
  syncSettingsForm();
  $("settings-msg").textContent = "Tokens removed from this device.";
}

function exportData(): void {
  const blob = new Blob([store.exportData()], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `fitto-statuses-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file: File): Promise<void> {
  try {
    const r = store.importData(await file.text());
    notice("ok", `Imported ${r.statuses} status(es) and ${r.sends} send record(s).`);
    render();
  } catch (e) {
    notice("error", e instanceof Error ? e.message : "Import failed.");
  }
}

function forgetDevice(): void {
  if (!confirm("Remove the remembered passphrase, tokens, statuses and settings from this device?")) return;
  store.forgetAll();
  lock();
  syncSettingsForm();
}

// ---------- wiring ----------

function init(): void {
  $("unlock-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const pass = $<HTMLInputElement>("passphrase").value;
    if (pass) void unlock(pass, $<HTMLInputElement>("remember-pass").checked).catch((e: unknown) => ($("unlock-error").textContent = String(e instanceof Error ? e.message : e)));
  });
  $("lock-btn").addEventListener("click", lock);
  $("filter").addEventListener("change", render);
  $("search").addEventListener("input", render);
  $("select-all").addEventListener("click", selectAllVisible);
  $("clear-sel").addEventListener("click", () => {
    selected.clear();
    render();
  });
  $("send-btn").addEventListener("click", sendSelected);
  $("save-settings").addEventListener("click", saveSettings);
  $("clear-tokens").addEventListener("click", clearTokens);
  $("export-btn").addEventListener("click", exportData);
  $<HTMLInputElement>("import-file").addEventListener("change", (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) void importData(f);
    (ev.target as HTMLInputElement).value = "";
  });
  $("forget-btn").addEventListener("click", forgetDevice);
  syncSettingsForm();

  const remembered = store.getSecret("passphrase");
  if (remembered) {
    $<HTMLInputElement>("remember-pass").checked = true;
    void unlock(remembered, true).catch(() => undefined);
  }
}

init();
