// ollama — local model provider. The workspace points at an Ollama
// HTTP endpoint (default http://ollama:11434 in our docker-compose,
// or http://host.docker.internal:11434 from inside containers, or
// http://localhost:11434 for native runs). Auth is optional: a bare local
// Ollama needs none, but a remote one behind a token-checking reverse
// proxy / tunnel (or the ollama-claude bridge with BRIDGE_TOKEN set) does —
// set the optional `bearer_token` credential and it's sent as
// `Authorization: Bearer …`.

import { platform, type AiCapability } from "@cobblr/platform-contract";
import { assertSafeAiEndpoint, pinnedFetch, type PinnedResponse } from "../ssrf.js";
import { TRANSIT_FIELD, viaBridge, edgeKeyFor, edgeFetch } from "./edge-transit.js";

/** Optional bearer auth for the endpoint. Returns {} when no token is
 *  configured (a bare local Ollama). A remote endpoint behind a
 *  token-checking proxy/tunnel — or the ollama-claude bridge with
 *  BRIDGE_TOKEN set — gets `Authorization: Bearer <token>`. */
export function authHeadersFor(credentials: Record<string, unknown>): Record<string, string> {
  const t = typeof credentials.bearer_token === "string" ? credentials.bearer_token.trim() : "";
  return t ? { authorization: `Bearer ${t}` } : {};
}

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
      bearer_token: {
        label: "Bearer token (optional — for a remote/proxied endpoint; sent as Authorization: Bearer …)",
        secret: true,
      },
      ...TRANSIT_FIELD,
    }),
    capabilities: SUPPORTED,
    invoke: async (ctx) => {
      const base = String(ctx.credentials.base_url ?? "http://ollama:11434").replace(/\/$/, "");
      // Transit: direct = SSRF-guarded fetch (block internal/loopback/metadata
      // per deployment policy, pin the connection — see ../ssrf.ts). Bridge =
      // the request rides the user's dial-out edge relay and the bridge does
      // the LAN call, so the guard doesn't apply (the cloud never dials the
      // address). See ./edge-transit.ts.
      const bridged = viaBridge(ctx.credentials);
      const pin = bridged ? null : await assertSafeAiEndpoint(base, platform().ai.getEndpointPolicy());
      const authHeaders = authHeadersFor(ctx.credentials);
      const call = (path: string, init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string }): Promise<PinnedResponse> =>
        bridged
          ? edgeFetch(edgeKeyFor(ctx.credentials, ctx.orgId), base, path, init)
          : pinnedFetch(`${base}${path}`, pin!, init);
      switch (ctx.capability) {
        case "embed-text": {
          const input = String(ctx.input.text ?? "");
          const res = await call("/api/embeddings", {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders },
            body: JSON.stringify({ model: ctx.model, prompt: input }),
          });
          // Don't echo the upstream body — for a read-SSRF that body is the
          // exfil channel; the status alone is enough to diagnose.
          if (!res.ok) throw new Error(`ollama: ${res.status}`);
          const body = (await res.json()) as { embedding: number[] };
          return { result: { vector: body.embedding }, cost_cents: 0 };
        }
        case "chat": {
          const messages = (ctx.input.messages as Array<{ role: string; content: string }>) ?? [];
          const res = await call("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders },
            body: JSON.stringify({ model: ctx.model, messages, stream: false }),
          });
          // Don't echo the upstream body — for a read-SSRF that body is the
          // exfil channel; the status alone is enough to diagnose.
          if (!res.ok) throw new Error(`ollama: ${res.status}`);
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
          const res = await call("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders },
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
          // Don't echo the upstream body — for a read-SSRF that body is the
          // exfil channel; the status alone is enough to diagnose.
          if (!res.ok) throw new Error(`ollama: ${res.status}`);
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
          const res = await call("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders },
            body: JSON.stringify({
              model: ctx.model,
              stream: false,
              format: ctx.capability === "extract-text" ? undefined : "json",
              messages: [msg],
            }),
          });
          // Don't echo the upstream body — for a read-SSRF that body is the
          // exfil channel; the status alone is enough to diagnose.
          if (!res.ok) throw new Error(`ollama: ${res.status}`);
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
        let res: PinnedResponse;
        if (viaBridge(credentials)) {
          res = await edgeFetch(edgeKeyFor(credentials), base, "/api/tags", { headers: authHeadersFor(credentials) });
        } else {
          const pin = await assertSafeAiEndpoint(base, platform().ai.getEndpointPolicy());
          res = await pinnedFetch(`${base}/api/tags`, pin, {
            headers: authHeadersFor(credentials),
          });
        }
        return { ok: res.ok };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  });
}
