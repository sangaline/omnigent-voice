import { sanitizeForSpeech, shouldAdaptForSpeech } from "./control.js";
import { Logger } from "./log.js";

interface CelerisOptions {
  apiKey?: string | undefined;
  baseUrl: string;
  model: string;
  logger: Logger;
}

export class CelerisAdapter {
  public constructor(private readonly options: CelerisOptions) {}

  public async adapt(raw: string): Promise<string> {
    const fallback = sanitizeForSpeech(raw);
    if (!this.options.apiKey || !shouldAdaptForSpeech(raw)) return fallback;

    const started = performance.now();
    this.options.logger.info("celeris.request.started");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: 256,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                "Turn the supplied agent result into a concise, natural spoken response. Preserve the conclusion, blockers, and any question the listener must answer. Do not speak markdown syntax, code blocks, IDs, URLs, or tool logs. Use one to four sentences. Never claim work not present in the result.",
            },
            { role: "user", content: raw },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Celeris returned HTTP ${response.status}`);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Celeris returned no spoken response");
      }
      this.options.logger.info("celeris.response.received", {
        durationMs: Math.round(performance.now() - started),
      });
      return sanitizeForSpeech(content);
    } catch (error) {
      this.options.logger.error("celeris.request.failed", error);
      return fallback;
    } finally {
      clearTimeout(timeout);
    }
  }
}

