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

/** OpenAI-compatible chat completions client (GitHub Models and OpenAI share this shape). */
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
    if (!res.ok) throw new Error(`${this.name} returned HTTP ${res.status}`);
    const data = (await res.json()) as ChatCompletion;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.name} returned an empty response`);
    return content;
  }
}

export function githubModels(token: string, model = "openai/gpt-4.1-mini", fetchImpl?: typeof fetch): LlmProvider {
  return new ChatCompletionsProvider(
    `github-models:${model}`,
    "https://models.github.ai/inference/chat/completions",
    token,
    model,
    { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    fetchImpl,
  );
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

/**
 * Picks a provider: FITTO_LLM=github|openai|heuristic forces one; otherwise
 * OPENAI_API_KEY if set, then GitHub Models via GITHUB_TOKEN, else none (heuristic scoring).
 */
export function providerFromEnv(env = process.env): LlmProvider | undefined {
  const choice = env.FITTO_LLM?.toLowerCase();
  const model = env.FITTO_MODEL || undefined;
  if (choice === "heuristic") return undefined;
  if (choice === "openai" || (!choice && env.OPENAI_API_KEY)) {
    if (!env.OPENAI_API_KEY) throw new Error("FITTO_LLM=openai but OPENAI_API_KEY is not set");
    return openAi(env.OPENAI_API_KEY, model);
  }
  if (choice === "github" || (!choice && env.GITHUB_TOKEN)) {
    if (!env.GITHUB_TOKEN) throw new Error("FITTO_LLM=github but GITHUB_TOKEN is not set");
    return githubModels(env.GITHUB_TOKEN, model);
  }
  return undefined;
}
