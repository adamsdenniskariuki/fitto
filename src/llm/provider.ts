export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class RateLimitError extends Error {}

export interface LlmProvider {
  name: string;
  /** Returns the raw assistant text (expected to be a JSON object). */
  complete(messages: ChatMessage[]): Promise<string>;
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
}

/** OpenAI-compatible chat completions client (OpenAI and compatible APIs). */
export class ChatCompletionsProvider implements LlmProvider {
  constructor(
    public readonly name: string,
    private readonly endpoint: string,
    private readonly token: string,
    private readonly model: string,
    private readonly extraHeaders: Record<string, string> = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429) throw new RateLimitError(`${this.name} rate limited`);
    if (!res.ok) {
      let code = "";
      try {
        const body = (await res.json()) as { error?: { code?: unknown } };
        if (typeof body.error?.code === "string") code = ` (${body.error.code.replace(/[^\w.-]/g, "").slice(0, 40)})`;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`${this.name} returned HTTP ${res.status}${code}`);
    }
    const data = (await res.json().catch(() => {
      throw new Error(`${this.name} returned a non-JSON response`);
    })) as ChatCompletion;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.name} returned an empty response`);
    return content;
  }
}

export function openAi(token: string, model = "gpt-4.1-mini", fetchImpl?: typeof fetch): LlmProvider {
  return new ChatCompletionsProvider(
    `openai:${model}`,
    "https://api.openai.com/v1/chat/completions",
    token,
    model,
    {},
    fetchImpl,
  );
}

interface AnthropicMessage {
  content?: { type?: string; text?: string }[];
}

/** Anthropic Messages API client (Claude). */
export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  constructor(
    private readonly token: string,
    private readonly model = "claude-haiku-5-5",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.name = `anthropic:${model}`;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.token,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        temperature: 0.2,
        ...(system ? { system } : {}),
        messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429 || res.status === 529) throw new RateLimitError(`${this.name} rate limited`);
    if (!res.ok) {
      let code = "";
      try {
        const body = (await res.json()) as { error?: { type?: unknown } };
        if (typeof body.error?.type === "string") code = ` (${body.error.type.replace(/[^\w.-]/g, "").slice(0, 40)})`;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`${this.name} returned HTTP ${res.status}${code}`);
    }
    const data = (await res.json().catch(() => {
      throw new Error(`${this.name} returned a non-JSON response`);
    })) as AnthropicMessage;
    const text = (data.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("");
    if (!text) throw new Error(`${this.name} returned an empty response`);
    return text;
  }
}

/**
 * Picks a provider: FITTO_LLM=openai|anthropic|heuristic forces one; otherwise OpenAI when
 * OPENAI_API_KEY is set, then Claude when ANTHROPIC_API_KEY is set, else none (offline heuristic scoring).
 * (GitHub Models, the former free default, was retired on 2026-07-30.)
 */
export function providerFromEnv(env = process.env): LlmProvider | undefined {
  const choice = env.FITTO_LLM?.toLowerCase();
  const model = env.FITTO_MODEL || undefined;
  if (choice === "heuristic") return undefined;
  if (choice === "github") throw new Error("FITTO_LLM=github is no longer supported: GitHub Models was retired");
  if (choice === "openai" || (!choice && env.OPENAI_API_KEY)) {
    if (!env.OPENAI_API_KEY) throw new Error("FITTO_LLM=openai but OPENAI_API_KEY is not set");
    return openAi(env.OPENAI_API_KEY, model);
  }
  if (choice === "anthropic" || choice === "claude" || (!choice && env.ANTHROPIC_API_KEY)) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("FITTO_LLM=anthropic but ANTHROPIC_API_KEY is not set");
    return new AnthropicProvider(env.ANTHROPIC_API_KEY, model);
  }
  if (choice) throw new Error(`unknown FITTO_LLM "${choice}" (use openai, anthropic or heuristic)`);
  return undefined;
}
