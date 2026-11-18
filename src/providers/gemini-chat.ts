/**
 * The naming and summary passes' reasoner for Gemini models, over the native
 * generateContent API. Those passes send transcript text. Gemini's OpenAI-compatible
 * endpoint logs requests for paid projects created on or after 26 Oct 2026 and rejects a
 * `store` field in either state, so a request there can't ask for zero storage; through
 * GeminiClient every request carries `store: false`. Same surface as OpenAICompatClient.
 */
import type { GeminiClient } from "./gemini.js";
import {
  chatJsonWith,
  type ChatClient,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
} from "./openai-compat.js";

/** Thinking counts against the output cap, so a caller's `maxTokens` (meant for the
 * visible answer) gets this much on top: a cap without it cut answers off mid-JSON. */
const THINKING_HEADROOM_TOKENS = 4096;

export class GeminiChatClient implements ChatClient {
  constructor(
    private gemini: GeminiClient,
    private defaultModel: string,
  ) {}

  async chat(
    model: string | undefined,
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content);
    // The passes send one user turn; any others are joined in order.
    const prompt = messages
      .filter((m) => m.role !== "system")
      .map((m) => m.content)
      .join("\n\n");
    const r = await this.gemini.generate(model ?? this.defaultModel, prompt, [], {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxTokens
        ? opts.maxTokens + THINKING_HEADROOM_TOKENS
        : undefined,
      responseJson: opts.responseJson,
      systemInstruction: system.length ? system.join("\n\n") : undefined,
      maxRetries: opts.maxRetries ?? 5,
      logKind: opts.logKind,
    });
    const usage = {
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
    };
    return r.error ? { text: r.text, usage, error: r.error } : { text: r.text, usage };
  }

  chatJson<T = unknown>(
    model: string | undefined,
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<{ data: T | null; raw: string; error?: string }> {
    return chatJsonWith<T>(this, model, messages, opts);
  }
}
