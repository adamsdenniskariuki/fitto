import { SafeSinkError, type Message, type Sink } from "./types.js";

type Env = NodeJS.ProcessEnv;
type Detail = "top" | "count";

const MAX_ITEMS = 3;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Short chat text: headline, up to three jobs (unless detail is "count"), and the site link. */
export function renderWhatsApp(m: Message, detail: Detail = "top"): string {
  const b = m.brief ?? { headline: m.subject, top: [] };
  const lines = [`*${b.headline}*`];
  if (detail === "top" && b.top.length) {
    b.top.slice(0, MAX_ITEMS).forEach((j, i) => {
      lines.push(`${i + 1}. ${clip(j.title, 70)} at ${clip(j.company, 40)}${j.score !== undefined ? ` (${j.score})` : ""}`);
    });
    if (b.top.length > MAX_ITEMS) lines.push(`+${b.top.length - MAX_ITEMS} more`);
  } else if (b.top.length) {
    lines.push(`${b.top.length} job${b.top.length === 1 ? "" : "s"} to review.`);
  }
  lines.push(b.link ? `Full list: ${b.link}` : "Full details are in your email.");
  return lines.join("\n");
}

/** One-line value for a WhatsApp template variable: no newlines/tabs, no 4+ spaces, bounded length. */
const oneLine = (s: string, n = 900) => clip(s.replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim(), n);

/**
 * Variables for a Meta-approved Twilio Content Template, e.g. the body
 * "Fitto update: {{1}}. Top picks: {{2}}. Full list: {{3}}".
 */
export function templateVariables(m: Message, detail: Detail = "top"): Record<string, string> {
  const b = m.brief ?? { headline: m.subject, top: [] };
  let picks: string;
  if (!b.top.length) picks = "none today";
  else if (detail === "top") {
    picks = b.top
      .slice(0, MAX_ITEMS)
      .map((j, i) => `${i + 1}) ${clip(j.title, 70)} at ${clip(j.company, 40)}${j.score !== undefined ? ` (${j.score})` : ""}`)
      .join("; ");
    if (b.top.length > MAX_ITEMS) picks += `; +${b.top.length - MAX_ITEMS} more`;
  } else picks = `${b.top.length} job${b.top.length === 1 ? "" : "s"} to review`;
  return {
    "1": oneLine(b.headline.replace(/^Fitto:\s*/i, "")),
    "2": oneLine(picks),
    "3": oneLine(b.link ?? "your email"),
  };
}

export function detailFrom(env: Env): Detail {
  return env.FITTO_WHATSAPP_DETAIL?.toLowerCase() === "count" ? "count" : "top";
}

/** Normalise "+254 712 345 678" / "254712345678" to E.164 "+254712345678". */
export function e164(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) throw new Error("FITTO_WHATSAPP_TO must be an international number, e.g. +254712345678");
  return `+${digits}`;
}

/** Official WhatsApp delivery through Twilio's Messages API (sandbox or approved sender). */
export class TwilioWhatsAppSink implements Sink {
  name = "whatsapp (twilio)";
  notifyOnly = true;
  constructor(
    private readonly env: Env,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}
  async send(m: Message): Promise<void> {
    const sid = this.env.TWILIO_ACCOUNT_SID!;
    const from = this.env.TWILIO_WHATSAPP_FROM || "+14155238886"; // Twilio sandbox number
    const body = new URLSearchParams({
      From: `whatsapp:${e164(from)}`,
      To: `whatsapp:${e164(this.env.FITTO_WHATSAPP_TO!)}`,
    });
    // A registered sender needs an approved template outside WhatsApp's 24-hour window.
    const contentSid = this.env.TWILIO_CONTENT_SID?.trim();
    if (contentSid) {
      body.set("ContentSid", contentSid);
      body.set("ContentVariables", JSON.stringify(templateVariables(m, detailFrom(this.env))));
    } else {
      body.set("Body", renderWhatsApp(m, detailFrom(this.env)));
    }
    const auth = Buffer.from(`${sid}:${this.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await this.fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    // Status and numeric Twilio code only: the response echoes phone numbers and the message body.
    if (!res.ok) {
      let code: unknown;
      try {
        code = ((await res.json()) as { code?: unknown }).code;
      } catch {
        /* non-JSON body */
      }
      const c = typeof code === "number" ? ` code ${code}` : "";
      throw new SafeSinkError(`Twilio returned HTTP ${res.status}${c}${twilioHint(code)}`);
    }
  }
}

/** Plain-language hints for the Twilio errors people usually hit. */
function twilioHint(code: unknown): string {
  const hints: Record<number, string> = {
    20003: ": check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN",
    21211: ": FITTO_WHATSAPP_TO is not a valid number",
    21606: ": TWILIO_WHATSAPP_FROM is not a WhatsApp sender on this account (sandbox: +14155238886)",
    63007: ": TWILIO_WHATSAPP_FROM is not a WhatsApp sender on this account (sandbox: +14155238886)",
    63015: ": join the sandbox first (send the join code to +14155238886)",
    63016: ": outside WhatsApp's 24-hour window; set TWILIO_CONTENT_SID to an approved template",
    21654: ": this sender needs an approved template; set TWILIO_CONTENT_SID",
    63027: ": template variables rejected; check the template has {{1}}, {{2}} and {{3}}",
  };
  return typeof code === "number" ? (hints[code] ?? "") : "";
}

/** Free personal gateway (callmebot.com): messages only the number that registered the key. */
export class CallMeBotSink implements Sink {
  name = "whatsapp (callmebot)";
  notifyOnly = true;
  constructor(
    private readonly env: Env,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}
  async send(m: Message): Promise<void> {
    const q = new URLSearchParams({
      phone: e164(this.env.FITTO_WHATSAPP_TO!),
      text: renderWhatsApp(m, detailFrom(this.env)),
      apikey: this.env.CALLMEBOT_API_KEY!,
    });
    const res = await this.fetchFn(`https://api.callmebot.com/whatsapp.php?${q}`, { method: "GET" });
    const text = await res.text().catch(() => "");
    // CallMeBot can answer 200 with an error page, so check the body for its error marker too.
    if (!res.ok || /APIKey is invalid|ERROR/i.test(text)) throw new SafeSinkError(`CallMeBot returned HTTP ${res.status}`);
  }
}

export function whatsappSinkFromEnv(env: Env): Sink | undefined {
  if (!env.FITTO_WHATSAPP_TO) return undefined;
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) return new TwilioWhatsAppSink(env);
  if (env.CALLMEBOT_API_KEY) return new CallMeBotSink(env);
  return undefined;
}
