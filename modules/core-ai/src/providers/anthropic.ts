// anthropic — Claude provider. Messages API.

import { platform, type AiCapability } from "@cobblr/platform-contract";
import { IDENTIFY_PROMPT, measurementContext } from "./identify-prompt.js";
import { toolsOf, turnsOf, anthropicToolsOf, anthropicMessagesOf, parseAnthropicContent } from "./tool-wire.js";

const SUPPORTED: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {
  chat: {
    models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"],
    defaultModel: "claude-haiku-4-5",
  },
  summarise: {
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    defaultModel: "claude-haiku-4-5",
  },
  "classify-image": {
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    defaultModel: "claude-haiku-4-5",
  },
  "identify-image": {
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    defaultModel: "claude-haiku-4-5",
  },
  "extract-text": {
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    defaultModel: "claude-haiku-4-5",
  },
  "match-to-catalog": {
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    defaultModel: "claude-haiku-4-5",
  },
};

const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-5": { input: 1500, output: 7500 },
  "claude-sonnet-4-5": { input: 300, output: 1500 },
  "claude-haiku-4-5": { input: 100, output: 500 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  return Math.ceil((inputTokens * p.input + outputTokens * p.output) / 1_000_000);
}

interface ClaudeContentBlock {
  type: "text" | "image";
  text?: string;
  source?: { type: "base64"; media_type: string; data: string };
}

export function register(): void {
  platform().ai.registerProvider({
    id: "anthropic",
    label: "Anthropic (Claude)",
    describeCredentials: () => ({
      api_key: { label: "Anthropic API key (sk-ant-…)", secret: true },
    }),
    capabilities: SUPPORTED,
    invoke: async (ctx) => {
      const apiKey = String(ctx.credentials.api_key ?? "");
      if (!apiKey) throw new Error("anthropic: missing api_key");
      const { messages, system } = buildMessages(ctx.capability, ctx.input);
      const body: Record<string, unknown> = {
        model: ctx.model,
        max_tokens: typeof ctx.config.max_tokens === "number" ? ctx.config.max_tokens : 1024,
        messages,
      };
      if (system) body.system = system;
      // Native tool-calling for chat: forward the neutral tool defs.
      const toolDefs = ctx.capability === "chat" ? toolsOf(ctx.input) : null;
      if (toolDefs) body.tools = anthropicToolsOf(toolDefs);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`anthropic: ${res.status} ${await res.text()}`);
      const out = (await res.json()) as {
        content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        usage: { input_tokens: number; output_tokens: number };
      };
      const parsed = parseAnthropicContent(out.content);
      const text = parsed.text;
      return {
        result:
          ctx.capability === "embed-text"
            ? { vector: [] }
            : ctx.capability === "chat"
              ? { role: "assistant", content: text, ...(parsed.tool_calls ? { tool_calls: parsed.tool_calls } : {}) }
              : ctx.capability === "summarise"
                ? { text }
                : { text },
        input_tokens: out.usage.input_tokens,
        output_tokens: out.usage.output_tokens,
        cost_cents: estimateCost(ctx.model, out.usage.input_tokens, out.usage.output_tokens),
      };
    },
    testConnection: async (credentials) => {
      const apiKey = String(credentials.api_key ?? "");
      if (!apiKey || !apiKey.startsWith("sk-ant-")) {
        return { ok: false, error: "api_key looks malformed (expected sk-ant-…)" };
      }
      return { ok: true };
    },
  });
}

function buildMessages(
  capability: AiCapability,
  input: Record<string, unknown>,
): { system?: string; messages: Array<{ role: string; content: ClaudeContentBlock[] }> } {
  switch (capability) {
    case "summarise": {
      const text = String(input.text ?? "");
      const lengthHint = String(input.lengthHint ?? "3 sentences");
      return {
        system: `Summarise in ${lengthHint}. Plain prose, no preamble.`,
        messages: [{ role: "user", content: [{ type: "text", text }] }],
      };
    }
    case "classify-image": {
      const prompt = String(input.prompt ?? "Classify this image with one of the supplied labels.");
      const labels = (input.labels as string[]) ?? [];
      const imageB64 = typeof input.image_b64 === "string" ? input.image_b64 : null;
      const mediaType = String(input.image_media_type ?? "image/png");
      const content: ClaudeContentBlock[] = [];
      if (imageB64) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: imageB64 },
        });
      }
      content.push({
        type: "text",
        text:
          `${prompt}\n\nAllowed labels: ${labels.join(", ")}\n` +
          `Reply with JSON shaped {"labels": [{"label": string, "confidence": number}]} ordered desc. JSON only.`,
      });
      return { messages: [{ role: "user", content }] };
    }
    case "identify-image": {
      const imageB64 = typeof input.image_b64 === "string" ? input.image_b64 : null;
      const mediaType = String(input.image_media_type ?? "image/jpeg");
      const content: ClaudeContentBlock[] = [];
      if (imageB64) {
        content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: imageB64 } });
      }
      content.push({ type: "text", text: IDENTIFY_PROMPT + measurementContext(input) });
      return { messages: [{ role: "user", content }] };
    }
    case "extract-text": {
      const imageB64 = typeof input.image_b64 === "string" ? input.image_b64 : null;
      const mediaType = String(input.image_media_type ?? "image/png");
      const content: ClaudeContentBlock[] = [];
      if (imageB64) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: imageB64 },
        });
      }
      content.push({ type: "text", text: "Read all text from the image. Return the text only." });
      return { messages: [{ role: "user", content }] };
    }
    case "match-to-catalog": {
      const userEntity = input.user_entity;
      const candidates = input.candidates;
      return {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `You're matching a user's entity to a catalog. Pick the best match.\n` +
                  `User entity:\n${JSON.stringify(userEntity, null, 2)}\n\n` +
                  `Candidates:\n${JSON.stringify(candidates, null, 2)}\n\n` +
                  `Reply with JSON: {"matches": [{"candidate_id": string, "confidence": number}]} ordered desc, top 3. JSON only.`,
              },
            ],
          },
        ],
      };
    }
    case "chat":
    default: {
      // Tool-aware turn mapping: assistant tool_calls → tool_use blocks; tool
      // results → user turns with tool_result blocks (Anthropic's dialect of
      // the neutral wire — see tool-wire.ts).
      const msgs = anthropicMessagesOf(turnsOf(input)) as Array<{ role: string; content: ClaudeContentBlock[] }>;
      const system = typeof input.system === "string" ? input.system : undefined;
      return { system, messages: msgs };
    }
  }
}
