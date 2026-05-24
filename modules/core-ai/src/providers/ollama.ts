// ollama — local model provider. The workspace points at an Ollama
// HTTP endpoint (default http://ollama:11434 in our docker-compose,
// or http://host.docker.internal:11434 from inside containers, or
// http://localhost:11434 for native runs). No API key required.

import { platform, type AiCapability } from "@cobblr/platform-contract";

const SUPPORTED: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {
  chat: { models: ["llama3.2", "qwen2.5", "phi3"], defaultModel: "llama3.2" },
  summarise: { models: ["llama3.2", "qwen2.5"], defaultModel: "llama3.2" },
  "classify-image": { models: ["llava", "llama3.2-vision"], defaultModel: "llava" },
  "extract-text": { models: ["llava", "llama3.2-vision"], defaultModel: "llava" },
  "embed-text": { models: ["nomic-embed-text", "mxbai-embed-large"], defaultModel: "nomic-embed-text" },
  "match-to-catalog": {
    models: ["llama3.2", "qwen2.5", "llava"],
    defaultModel: "llama3.2",
  },
};

export function register(): void {
  platform().ai.registerProvider({
    id: "ollama",
    label: "Ollama (local)",
    describeCredentials: () => ({
      base_url: {
        label: "Ollama base URL (e.g. http://ollama:11434)",
        secret: false,
      },
    }),
    capabilities: SUPPORTED,
    invoke: async (ctx) => {
      const base = String(ctx.credentials.base_url ?? "http://ollama:11434").replace(/\/$/, "");
      switch (ctx.capability) {
        case "embed-text": {
          const input = String(ctx.input.text ?? "");
          const res = await fetch(`${base}/api/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: ctx.model, prompt: input }),
          });
          if (!res.ok) throw new Error(`ollama: ${res.status} ${await res.text()}`);
          const body = (await res.json()) as { embedding: number[] };
          return { result: { vector: body.embedding }, cost_cents: 0 };
        }
        case "chat": {
          const messages = (ctx.input.messages as Array<{ role: string; content: string }>) ?? [];
          const res = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: ctx.model, messages, stream: false }),
          });
          if (!res.ok) throw new Error(`ollama: ${res.status} ${await res.text()}`);
          const body = (await res.json()) as {
            message: { role: string; content: string };
            prompt_eval_count?: number;
            eval_count?: number;
          };
          return {
            result: body.message,
            input_tokens: body.prompt_eval_count,
            output_tokens: body.eval_count,
            cost_cents: 0,
          };
        }
        case "summarise": {
          const text = String(ctx.input.text ?? "");
          const lengthHint = String(ctx.input.lengthHint ?? "3 sentences");
          const res = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: ctx.model,
              stream: false,
              messages: [
                {
                  role: "system",
                  content: `Summarise the user's text in ${lengthHint}. Output plain prose, no preamble.`,
                },
                { role: "user", content: text },
              ],
            }),
          });
          if (!res.ok) throw new Error(`ollama: ${res.status} ${await res.text()}`);
          const body = (await res.json()) as { message: { content: string } };
          return { result: { text: body.message.content }, cost_cents: 0 };
        }
        case "classify-image":
        case "extract-text":
        case "match-to-catalog": {
          // Image-or-text generic chat call. Caller passes
          // input.prompt + optional input.image_b64. Returned as
          // raw text the caller parses (JSON for classify/match).
          const prompt = String(ctx.input.prompt ?? "");
          const imageB64 = typeof ctx.input.image_b64 === "string" ? ctx.input.image_b64 : null;
          const msg: Record<string, unknown> = { role: "user", content: prompt };
          if (imageB64) msg.images = [imageB64];
          const res = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: ctx.model,
              stream: false,
              format: ctx.capability === "extract-text" ? undefined : "json",
              messages: [msg],
            }),
          });
          if (!res.ok) throw new Error(`ollama: ${res.status} ${await res.text()}`);
          const body = (await res.json()) as { message: { content: string } };
          return { result: { text: body.message.content }, cost_cents: 0 };
        }
        default:
          throw new Error(`ollama: capability ${ctx.capability} not implemented`);
      }
    },
    testConnection: async (credentials) => {
      const base = String(credentials.base_url ?? "http://ollama:11434").replace(/\/$/, "");
      try {
        const res = await fetch(`${base}/api/tags`);
        return { ok: res.ok };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  });
}
