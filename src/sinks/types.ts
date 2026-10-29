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
}

/**
 * A delivery channel. Email is the default; other channels (for example The Next
 * Chapter) implement the same interface. Sinks must never log message content.
 */
export interface Sink {
  name: string;
  send(message: Message): Promise<void>;
}
