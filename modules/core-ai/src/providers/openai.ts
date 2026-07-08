// openai — OpenAI provider. Uses the responses API for chat /
// embed / classify-image / extract-text. Cost is per-model from a
// static price table (rough, updated on doc-PR cadence).

import { platform, type AiCapability } from "@cobblr/platform-contract";
import { IDENTIFY_PROMPT, measurementContext } from "./identify-prompt.js";

const SUPPORTED: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {
  chat: { models: ["gpt-4o", "gpt-4o-mini", "o1-mini"], defaultModel: "gpt-4o-mini" },
  summarise: { models: ["gpt-4o", "gpt-4o-mini"], defaultModel: "gpt-4o-mini" },
  "classify-image": { models: ["gpt-4o", "gpt-4o-mini"], defaultModel: "gpt-4o-mini" },
  "identify-image": { models: ["gpt-4o", "gpt-4o-mini"], defaultModel: "gpt-4o-mini" },
  "extract-text": { models: ["gpt-4o", "gpt-4o-mini"], defaultModel: "gpt-4o-mini" },
  "embed-text": {
    models: ["text-embedding-3-small", "text-embedding-3-large"],
    defaultModel: "text-embedding-3-small",
  },
  "match-to-catalog": {
    models: ["gpt-4o", "gpt-4o-mini"],
    defaultModel: "gpt-4o-mini",
  },
};

/** Token cost in cents per million tokens. Approximate — update when
 *  OpenAI changes pricing. */
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 250, output: 1000 },        // $2.50 / $10 per Mtok
  "gpt-4o-mini": { input: 15, output: 60 },      // $0.15 / $0.60 per Mtok
  "o1-mini": { input: 300, output: 1200 },       // $3 / $12 per Mtok
  "text-embedding-3-small": { input: 2, output: 0 },
  "text-embedding-3-large": { input: 13, output: 0 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  return Math.ceil((inputTokens * p.input + outputTokens * p.output) / 1_000_000);
}

export function register(): void {
  platform().ai.registerProvider({
    id: "openai",
    label: "OpenAI",
    describeCredentials: () => ({
      api_key: { label: "OpenAI API key (sk-…)", secret: true },
    }),
    capabilities: SUPPORTED,
    invoke: async (ctx) => {
      const apiKey = String(ctx.credentials.api_key ?? "");
      if (!apiKey) throw new Error("openai: missing api_key");
      switch (ctx.capability) {
        case "embed-text": {
          const text = String(ctx.input.text ?? "");
          const res = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model: ctx.model, input: text }),
          });
          if (!res.ok) throw new Error(`openai: ${res.status} ${await res.text()}`);
          const body = (await res.json()) as {
            data: Array<{ embedding: number[] }>;
            usage: { prompt_tokens: number; total_tokens: number };
          };
          return {
            result: { vector: body.data[0]?.embedding ?? [] },
            input_tokens: body.usage.prompt_tokens,
            output_tokens: 0,
            cost_cents: estimateCost(ctx.model, body.usage.prompt_tokens, 0),
          };
        }
        case "chat":
        case "summarise":
        case "classify-image":
        case "identify-image":
        case "extract-text":
        case "match-to-catalog": {
          const messages = buildMessages(ctx.capability, ctx.input);
          const body: Record<string, unknown> = {
            model: ctx.model,
            messages,
          };
          if (
            ctx.capability === "classify-image" ||
            ctx.capability === "identify-image" ||
            ctx.capability === "match-to-catalog"
          ) {
            body.response_format = { type: "json_object" };
          }
          const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`openai: ${res.status} ${await res.text()}`);
          const out = (await res.json()) as {
            choices: Array<{ message: { role: string; content: string } }>;
            usage: { prompt_tokens: number; completion_tokens: number };
          };
          return {
            result: out.choices[0]?.message ?? { role: "assistant", content: "" },
            input_tokens: out.usage.prompt_tokens,
            output_tokens: out.usage.completion_tokens,
            cost_cents: estimateCost(ctx.model, out.usage.prompt_tokens, out.usage.completion_tokens),
          };
        }
        default:
          throw new Error(`openai: capability ${ctx.capability} not implemented`);
      }
    },
    testConnection: async (credentials) => {
      const apiKey = String(credentials.api_key ?? "");
      if (!apiKey || !apiKey.startsWith("sk-")) {
        return { ok: false, error: "api_key looks malformed (expected sk-…)" };
      }
      try {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        return { ok: res.ok, error: res.ok ? undefined : `status ${res.status}` };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  });
}

export function buildMessages(
  capability: AiCapability,
  input: Record<string, unknown>,
): Array<{ role: string; content: unknown }> {
  switch (capability) {
    case "summarise": {
      const text = String(input.text ?? "");
      const lengthHint = String(input.lengthHint ?? "3 sentences");
      return [
        { role: "system", content: `Summarise in ${lengthHint}. Plain prose, no preamble.` },
        { role: "user", content: text },
      ];
    }
    case "classify-image": {
      const prompt = String(input.prompt ?? "Classify this image with one of the supplied labels.");
      const labels = (input.labels as string[]) ?? [];
      const imageUrl = typeof input.image_url === "string" ? input.image_url : null;
      const imageB64 = typeof input.image_b64 === "string" ? input.image_b64 : null;
      const content: Array<Record<string, unknown>> = [
        {
          type: "text",
          text:
            `${prompt}\n\nAllowed labels: ${labels.join(", ")}\n` +
            `Return JSON shaped as {"labels": [{"label": string, "confidence": number}]} ordered desc.`,
        },
      ];
      if (imageUrl) content.push({ type: "image_url", image_url: { url: imageUrl } });
      else if (imageB64) {
        content.push({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${imageB64}` },
        });
      }
      return [{ role: "user", content }];
    }
    case "identify-image": {
      const mediaType = String(input.image_media_type ?? "image/jpeg");
      const imageUrl = typeof input.image_url === "string" ? input.image_url : null;
      const imageB64 = typeof input.image_b64 === "string" ? input.image_b64 : null;
      const content: Array<Record<string, unknown>> = [{ type: "text", text: IDENTIFY_PROMPT + measurementContext(input) }];
      if (imageUrl) content.push({ type: "image_url", image_url: { url: imageUrl } });
      else if (imageB64) {
        content.push({ type: "image_url", image_url: { url: `data:${mediaType};base64,${imageB64}` } });
      }
      return [{ role: "user", content }];
    }
    case "extract-text": {
      const imageUrl = typeof input.image_url === "string" ? input.image_url : null;
      const imageB64 = typeof input.image_b64 === "string" ? input.image_b64 : null;
      const content: Array<Record<string, unknown>> = [
        { type: "text", text: "Read all text from this image. Return the text only." },
      ];
      if (imageUrl) content.push({ type: "image_url", image_url: { url: imageUrl } });
      else if (imageB64) {
        content.push({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${imageB64}` },
        });
      }
      return [{ role: "user", content }];
    }
    case "match-to-catalog": {
      const userEntity = input.user_entity;
      const candidates = input.candidates;
      const imageUrl = typeof input.image_url === "string" ? input.image_url : null;
      const text =
        `You're matching a user's entity to a catalog. Pick the best match.\n` +
        `User entity:\n${JSON.stringify(userEntity, null, 2)}\n\n` +
        `Candidates:\n${JSON.stringify(candidates, null, 2)}\n\n` +
        `Return JSON: {"matches": [{"candidate_id": string, "confidence": number}]} ordered desc, top 3.`;
      const content: Array<Record<string, unknown>> = [{ type: "text", text }];
      if (imageUrl) content.push({ type: "image_url", image_url: { url: imageUrl } });
      return [{ role: "user", content }];
    }
    case "chat":
    default: {
      const msgs = ((input.messages as Array<{ role: string; content: string }>) ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      // Honour a first-class `system` prompt (chat.ts passes it here, not as a
      // role:"system" message) by prepending it as the system turn.
      const system = typeof input.system === "string" ? input.system : undefined;
      return system ? [{ role: "system", content: system }, ...msgs] : msgs;
    }
  }
}
