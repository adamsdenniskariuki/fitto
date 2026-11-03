/** A rendered message for one delivery (daily digest, weekly summary, ...). */
export interface Message {
  kind: "daily" | "weekly";
  subject: string;
  text: string;
  html: string;
  /** Number of jobs in the message; the only detail safe to log. */
  count: number;
  /** Public-safe rendering (counts only) for job summaries and logs. */
  redacted: string;
  /** Short form for chat channels such as WhatsApp. */
  brief?: Brief;
}

export interface Brief {
  /** One line, e.g. "Fitto: 6 job matches for 2026-11-03". */
  headline: string;
  /** Best jobs first; chat sinks show at most a few. */
  top: { title: string; company: string; score?: number }[];
  /** Where to see the full list (the encrypted site), if configured. */
  link?: string;
}

/**
 * A delivery channel. Email is the default; other channels (for example The Next
 * Chapter) implement the same interface. Sinks must never log message content.
 */
export interface Sink {
  name: string;
  /** A short notification channel (e.g. WhatsApp) rather than the full digest. */
  notifyOnly?: boolean;
  send(message: Message): Promise<void>;
}
