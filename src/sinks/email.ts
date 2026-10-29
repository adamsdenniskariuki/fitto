import nodemailer from "nodemailer";
import type { Message, Sink } from "./types.js";

type Env = NodeJS.ProcessEnv;

export class SmtpSink implements Sink {
  name = "email (smtp)";
  constructor(
    private readonly env: Env,
    private readonly transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      secure: Number(env.SMTP_PORT || 587) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    }),
  ) {}
  async send(m: Message): Promise<void> {
    await this.transport.sendMail({
      from: this.env.FITTO_EMAIL_FROM || this.env.SMTP_USER,
      to: this.env.FITTO_EMAIL_TO,
      subject: m.subject,
      text: m.text,
      html: m.html,
    });
  }
}

export class ResendSink implements Sink {
  name = "email (resend)";
  constructor(
    private readonly env: Env,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}
  async send(m: Message): Promise<void> {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.env.FITTO_EMAIL_FROM || "Fitto <onboarding@resend.dev>",
        to: [this.env.FITTO_EMAIL_TO],
        subject: m.subject,
        text: m.text,
        html: m.html,
      }),
    });
    // Status only: the response body can echo recipient addresses.
    if (!res.ok) throw new Error(`Resend returned HTTP ${res.status}`);
  }
}

export function emailSinkFromEnv(env: Env): Sink | undefined {
  if (!env.FITTO_EMAIL_TO) return undefined;
  if (env.RESEND_API_KEY) return new ResendSink(env);
  if (env.SMTP_HOST) return new SmtpSink(env);
  return undefined;
}
