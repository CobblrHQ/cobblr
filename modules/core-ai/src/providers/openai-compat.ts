// openai-compat — ANY server speaking the OpenAI v1 wire format: LM Studio,
// vLLM, llama.cpp server, LocalAI, Jan, OpenRouter, Groq, Together… One
// provider, user-supplied base URL, optional key (LM Studio ignores keys;
// hosted gateways need one). Reuses the OpenAI message builder — the wire
// format IS the compatibility contract — and the Ollama providers' SSRF
// posture (validated + connection-pinned fetch), since base_url is
// workspace-supplied and usually points into the user's own LAN.
//
// Model names are the user's own (whatever the server loaded/serves) — set
// them per capability in the AI config; the static list here is only a
// placeholder so resolution has a fallback. LM Studio answers with its loaded
// model whatever you send; vLLM & gateways need the exact name.

import { platform, type AiCapability } from "@cobblr/platform-contract";
import { assertSafeAiEndpoint, pinnedFetch, type PinnedResponse } from "../ssrf.js";
import { TRANSIT_FIELD, viaBridge, edgeKeyFor, edgeFetch } from "./edge-transit.js";
import { buildMessages } from "./openai.js";

const SUPPORTED: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {
  chat: { models: ["default"], defaultModel: "default" },
  summarise: { models: ["default"], defaultModel: "default" },
  "classify-image": { models: ["default"], defaultModel: "default" },
  "identify-image": { models: ["default"], defaultModel: "default" },
  "extract-text": { models: ["default"], defaultModel: "default" },
  "match-to-catalog": { models: ["default"], defaultModel: "default" },
  "embed-text": { models: ["default"], defaultModel: "default" },
};

export function baseOf(credentials: Record<string, unknown>): string {
  let base = String(credentials.base_url ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("openai-compat: base_url is required (e.g. http://192.168.1.50:1234/v1)");
  // LM Studio / llama.cpp / vLLM all mount under /v1 — append it when the
  // user pasted the bare host, so both forms work.
  if (!/\/v\d+$/.test(base)) base = `${base}/v1`;
  return base;
}

export function authHeadersFor(credentials: Record<string, unknown>): Record<string, string> {
  const k = typeof credentials.api_key === "string" ? credentials.api_key.trim() : "";
  return k ? { authorization: `Bearer ${k}` } : {};
}

export function register(): void {
  platform().ai.registerProvider({
    id: "openai-compat",
    label: "OpenAI-compatible (LM Studio, vLLM, …)",
    describeCredentials: () => ({
      base_url: {
        label: "Base URL (e.g. http://192.168.1.50:1234/v1 — LM Studio's local server)",
        secret: false,
      },
      api_key: {
        label: "API key (optional — LM Studio needs none; gateways like OpenRouter do)",
        secret: true,
      },
      ...TRANSIT_FIELD,
    }),
    capabilities: SUPPORTED,
    invoke: async (ctx) => {
      const base = baseOf(ctx.credentials);
      // Transit: direct = SSRF-guarded pinned fetch; bridge = the request rides
      // the user's dial-out edge relay and the bridge does the LAN call (e.g.
      // LM Studio on their desk). See ./edge-transit.ts.
      const bridged = viaBridge(ctx.credentials);
      const pin = bridged ? null : await assertSafeAiEndpoint(base, platform().ai.getEndpointPolicy());
      const headers = { "content-type": "application/json", ...authHeadersFor(ctx.credentials) };
      const call = (path: string, init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string }): Promise<PinnedResponse> =>
        bridged
          ? edgeFetch(edgeKeyFor(ctx.credentials, ctx.orgId), base, path, init)
          : pinnedFetch(`${base}${path}`, pin!, init);
      switch (ctx.capability) {
        case "embed-text": {
          const res = await call("/embeddings", {
            method: "POST",
            headers,
            body: JSON.stringify({ model: ctx.model, input: String(ctx.input.text ?? "") }),
          });
          if (!res.ok) throw new Error(`openai-compat: ${res.status} ${await res.text()}`);
          const body = (await res.json()) as {
            data: Array<{ embedding: number[] }>;
            usage?: { prompt_tokens?: number };
          };
          return {
            result: { vector: body.data[0]?.embedding ?? [] },
            input_tokens: body.usage?.prompt_tokens ?? 0,
            output_tokens: 0,
            cost_cents: 0, // self-hosted / user-billed — Cobblr never estimates it
          };
        }
        case "chat":
        case "summarise":
        case "classify-image":
        case "identify-image":
        case "extract-text":
        case "match-to-catalog": {
          const body: Record<string, unknown> = {
            model: ctx.model,
            messages: buildMessages(ctx.capability, ctx.input),
          };
          // response_format json_object is OpenAI-specific; local servers vary.
          // The JSON-shaped prompts already instruct the model, and every
          // consumer robust-parses (parseJsonReply) — so omit it and stay
          // compatible with the widest server set.
          const res = await call("/chat/completions", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`openai-compat: ${res.status} ${await res.text()}`);
          const out = (await res.json()) as {
            choices: Array<{ message: { role: string; content: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          return {
            result: out.choices[0]?.message ?? { role: "assistant", content: "" },
            input_tokens: out.usage?.prompt_tokens ?? 0,
            output_tokens: out.usage?.completion_tokens ?? 0,
            cost_cents: 0,
          };
        }
        default:
          throw new Error(`openai-compat: capability ${ctx.capability} not implemented`);
      }
    },
    testConnection: async (credentials) => {
      try {
        const base = baseOf(credentials);
        let res: PinnedResponse;
        if (viaBridge(credentials)) {
          res = await edgeFetch(edgeKeyFor(credentials), base, "/models", { headers: authHeadersFor(credentials) });
        } else {
          const pin = await assertSafeAiEndpoint(base, platform().ai.getEndpointPolicy());
          res = await pinnedFetch(`${base}/models`, pin, { headers: authHeadersFor(credentials) });
        }
        if (!res.ok) return { ok: false, error: `status ${res.status}` };
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        const models = (body.data ?? []).map((m) => m.id).slice(0, 5);
        return { ok: true, error: undefined, detail: models.length ? `serving: ${models.join(", ")}` : undefined } as { ok: boolean; error?: string };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  });
}
