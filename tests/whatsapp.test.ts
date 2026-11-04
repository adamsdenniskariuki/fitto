import { describe, expect, it } from "vitest";
import { deliver, sinksFromEnv, type Message, type Sink } from "../src/sinks/index.js";
import { CallMeBotSink, e164, renderWhatsApp, templateVariables, TwilioWhatsAppSink, whatsappSinkFromEnv } from "../src/sinks/whatsapp.js";
import { SafeSinkError } from "../src/sinks/types.js";

const msg = (n = 5): Message => ({
  kind: "daily",
  subject: "Fitto: 5 job matches",
  text: "full text",
  html: "<p>full</p>",
  count: n,
  redacted: "redacted",
  brief: {
    headline: "Fitto: 5 job matches for 2026-11-03",
    top: Array.from({ length: n }, (_, i) => ({ title: `Engineer ${i + 1}`, company: `Co ${i + 1}`, score: 90 - i })),
    link: "https://fitto.example/jobs.html",
  },
});

const capture = (status = 200, body = "") => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
};

describe("WhatsApp rendering", () => {
  it("shows the top three, a remainder and the site link", () => {
    expect(renderWhatsApp(msg())).toBe(
      ["*Fitto: 5 job matches for 2026-11-03*", "1. Engineer 1 at Co 1 (90)", "2. Engineer 2 at Co 2 (89)", "3. Engineer 3 at Co 3 (88)", "+2 more", "Full list: https://fitto.example/jobs.html"].join("\n"),
    );
  });

  it("count mode omits job titles and companies", () => {
    const t = renderWhatsApp(msg(), "count");
    expect(t).toContain("5 jobs to review.");
    expect(t).not.toContain("Engineer");
    expect(t).not.toContain("Co 1");
  });

  it("falls back to the email when no site is configured", () => {
    const m = msg(1);
    m.brief!.link = undefined;
    expect(renderWhatsApp(m)).toContain("Full details are in your email.");
  });

  it("normalises phone numbers", () => {
    expect(e164("+254 712 345-678")).toBe("+254712345678");
    expect(() => e164("123")).toThrow();
  });
});

describe("WhatsApp sinks", () => {
  it("Twilio posts a form with basic auth and whatsapp: addresses", async () => {
    const { calls, fetchFn } = capture(201);
    const env = { FITTO_WHATSAPP_TO: "+254712345678", TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok" };
    await new TwilioWhatsAppSink(env, fetchFn).send(msg());
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("To")).toBe("whatsapp:+254712345678");
    expect(form.get("From")).toBe("whatsapp:+14155238886");
    expect(form.get("Body")).toContain("Engineer 1");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("AC123:tok").toString("base64")}`);
  });

  it("Twilio sends an approved template when TWILIO_CONTENT_SID is set", async () => {
    const { calls, fetchFn } = capture(201);
    const env = { FITTO_WHATSAPP_TO: "+254712345678", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_WHATSAPP_FROM: "+254700000000", TWILIO_CONTENT_SID: "HX123" };
    await new TwilioWhatsAppSink(env, fetchFn).send(msg());
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("Body")).toBeNull();
    expect(form.get("ContentSid")).toBe("HX123");
    const vars = JSON.parse(form.get("ContentVariables")!) as Record<string, string>;
    expect(vars["1"]).toBe("5 job matches for 2026-11-03");
    expect(vars["2"]).toBe("1) Engineer 1 at Co 1 (90); 2) Engineer 2 at Co 2 (89); 3) Engineer 3 at Co 3 (88); +2 more");
    expect(vars["3"]).toBe("https://fitto.example/jobs.html");
    expect(Object.values(vars).join("")).not.toMatch(/[\n\t]/);
  });

  it("template variables respect count mode", () => {
    expect(templateVariables(msg(), "count")["2"]).toBe("5 jobs to review");
  });

  it("Twilio errors carry the status only", async () => {
    const { fetchFn } = capture(401, '{"message":"+254712345678 secret body"}');
    const env = { FITTO_WHATSAPP_TO: "+254712345678", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" };
    await expect(new TwilioWhatsAppSink(env, fetchFn).send(msg())).rejects.toThrow(/^Twilio returned HTTP 401$/);
  });

  it("Twilio errors add the numeric code and a hint, never the response message", async () => {
    const { fetchFn } = capture(400, '{"code":63007,"message":"whatsapp:+254712345678 not found"}');
    const env = { FITTO_WHATSAPP_TO: "+254712345678", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" };
    const err = await new TwilioWhatsAppSink(env, fetchFn).send(msg()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SafeSinkError);
    expect((err as Error).message).toMatch(/^Twilio returned HTTP 400 code 63007: TWILIO_WHATSAPP_FROM/);
    expect((err as Error).message).not.toContain("254712345678");
  });

  it("CallMeBot sends a GET and detects error pages served with 200", async () => {
    const ok = capture(200, "Message queued");
    const env = { FITTO_WHATSAPP_TO: "254712345678", CALLMEBOT_API_KEY: "k1" };
    await new CallMeBotSink(env, ok.fetchFn).send(msg());
    const u = new URL(ok.calls[0]!.url);
    expect(u.host).toBe("api.callmebot.com");
    expect(u.searchParams.get("phone")).toBe("+254712345678");
    expect(u.searchParams.get("apikey")).toBe("k1");
    const bad = capture(200, "APIKey is invalid");
    await expect(new CallMeBotSink(env, bad.fetchFn).send(msg())).rejects.toThrow(/CallMeBot/);
  });

  it("selects Twilio over CallMeBot and needs a number", () => {
    expect(whatsappSinkFromEnv({ CALLMEBOT_API_KEY: "k" })).toBeUndefined();
    expect(whatsappSinkFromEnv({ FITTO_WHATSAPP_TO: "+254712345678", CALLMEBOT_API_KEY: "k" })?.name).toBe("whatsapp (callmebot)");
    expect(
      whatsappSinkFromEnv({ FITTO_WHATSAPP_TO: "+254712345678", CALLMEBOT_API_KEY: "k", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t" })?.name,
    ).toBe("whatsapp (twilio)");
    const sinks = sinksFromEnv({ FITTO_EMAIL_TO: "a@b.c", RESEND_API_KEY: "r", FITTO_WHATSAPP_TO: "+254712345678", CALLMEBOT_API_KEY: "k" }, false);
    expect(sinks.map((s) => s.name)).toEqual(["email (resend)", "whatsapp (callmebot)"]);
  });
});

describe("deliver with a notification sink", () => {
  const sink = (name: string, fail: boolean, notifyOnly = false): Sink => ({
    name,
    notifyOnly,
    send: async () => {
      if (fail) throw new Error("x");
    },
  });

  it("does not count a WhatsApp nudge as delivered when the email failed", async () => {
    expect(await deliver([sink("email", true), sink("wa", false, true)], msg())).toBe(false);
    expect(await deliver([sink("email", false), sink("wa", true, true)], msg())).toBe(true);
  });

  it("counts WhatsApp when it is the only channel", async () => {
    expect(await deliver([sink("wa", false, true)], msg())).toBe(true);
  });
});
