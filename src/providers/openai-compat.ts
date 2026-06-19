/**
 * Minimal OpenAI-compatible chat client (fetch-based, no SDK dep). Works with
 * DeepSeek, Groq, OpenAI, and any provider exposing /chat/completions.
 * Used for text-reasoning passes (speaker identification, refinement) where native
 * audio isn't needed — DeepSeek is cheap and strong for this.
 */
import { logLlmCall } from "./llm-log.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  responseJson?: boolean;
  maxRetries?: number;
  /** What this call is for (logged): identify | … */
  logKind?: string;
}

const PROVIDER_BASE: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
};

export class OpenAICompatClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private defaultModel: string,
    private providerName = "openai-compat",
  ) {}

  static fromProvider(provider: string, apiKey: string, defaultModel: string): OpenAICompatClient {
    const base = PROVIDER_BASE[provider] ?? provider;
    return new OpenAICompatClient(base, apiKey, defaultModel, provider);
  }

  async chat(model: string | undefined, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const m = model ?? this.defaultModel;
    const maxRetries = opts.maxRetries ?? 2;
    const body: Record<string, unknown> = {
      model: m,
      messages,
      temperature: opts.temperature ?? 0.2,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.responseJson) {
      body.response_format = { type: "json_object" };
    }

    let lastError: string | undefined;
    const promptStr = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
        }
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = data.choices?.[0]?.message?.content ?? "";
        const usage = {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        };
        logLlmCall({
          ts: new Date(t0).toISOString(),
          provider: this.providerName,
          model: m,
          kind: opts.logKind,
          prompt: promptStr,
          response: text,
          usage,
          durationMs: Date.now() - t0,
          attempt: attempt + 1,
        });
        return { text, usage };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logLlmCall({
          ts: new Date(t0).toISOString(),
          provider: this.providerName,
          model: m,
          kind: opts.logKind,
          prompt: promptStr,
          response: "",
          durationMs: Date.now() - t0,
          attempt: attempt + 1,
          error: lastError,
        });
        if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    return { text: "", usage: { inputTokens: 0, outputTokens: 0 }, error: lastError };
  }

  async chatJson<T = unknown>(model: string | undefined, messages: ChatMessage[], opts: ChatOptions = {}): Promise<{ data: T | null; raw: string; error?: string }> {
    const res = await this.chat(model, messages, { ...opts, responseJson: true });
    if (res.error || !res.text) return { data: null, raw: res.text, error: res.error };
    try {
      let txt = res.text.trim();
      const fence = txt.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fence && fence[1]) txt = fence[1];
      return { data: JSON.parse(txt) as T, raw: res.text };
    } catch (err) {
      return { data: null, raw: res.text, error: `JSON parse: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
