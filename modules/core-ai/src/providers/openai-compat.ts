// openai-compat — ANY server speaking the OpenAI v1 wire format: LM Studio,
// vLLM, llama.cpp server, LocalAI, Jan, OpenRouter, Groq, Together… One
// provider, user-supplied base URL, optional key (LM Studio ignores keys;
// hosted gateways need one). Reuses the OpenAI message builder — the wire
// format IS the compatibility contract — and the Ollama providers' SSRF
// posture (validated + connection-pinned fetch), since base_url is
// workspace-supplied and usually points into the user's own LAN.
//
// Model names are the user's own. Three tiers, most-specific wins:
//   1. an explicit capability-default model set in the AI config (ctx.model),
//   2. the connection's own `model` credential (one knob on the connection —
//      what a gateway like OpenRouter needs, since it has no "default"),
//   3. the "default" placeholder (LM Studio answers with its loaded model
//      whatever you send).
// The whole provider body is exported as buildCompatProvider() so shaped
// presets (OpenRouter) register the same machinery with a fixed base URL.

import { platform, type AiCapability, type AiProviderDef } from "@cobblr/platform-contract";
import { assertSafeAiEndpoint, pinnedFetch, type PinnedResponse } from "../ssrf.js";
import { TRANSIT_FIELD, viaBridge, edgeKeyFor, edgeFetch } from "./edge-transit.js";
import { buildMessages } from "./openai.js";
import { toolsOf, openAiToolsOf, parseOpenAiToolCalls, looksLikeNoToolSupport, stripLeakedReasoning } from "./tool-wire.js";
import { promptFingerprint } from "./prompt-fingerprint.js";

export const SUPPORTED: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {
  chat: { models: ["default"], defaultModel: "default" },
  summarise: { models: ["default"], defaultModel: "default" },
  "classify-image": { models: ["default"], defaultModel: "default" },
  "identify-image": { models: ["default"], defaultModel: "default" },
  "rank-images": { models: ["default"], defaultModel: "default" },
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

/** The model actually sent on the wire. An explicit capability-default from
 *  the AI config wins; else the connection's own `model` credential; else the
 *  "default" placeholder. Exported for tests. */
export function effectiveModel(
  ctxModel: string | undefined,
  credentials: Record<string, unknown>,
  fallback?: string,
): string {
  const connModel = typeof credentials.model === "string" ? credentials.model.trim() : "";
  if (ctxModel && ctxModel !== "default") return ctxModel;
  // `fallback` is a preset's own sensible default. Without one this returns the literal
  // "default", which LM Studio understands (it serves whatever is loaded) and a hosted
  // gateway does not — it is a guaranteed 4xx there. A preset that knows its provider's
  // model name can therefore leave the field blank for the user instead of demanding it.
  // `fallback` outranks ctxModel here because a ctxModel of "default" is the sentinel
  // for "no preference", not a request for a model literally named default. Ordering it
  // ahead of the fallback silently skipped the preset's model and sent "default" to a
  // gateway that has none.
  return connModel || fallback || ctxModel || "default";
}

// Free tiers fail transiently and often. Verifying the Google AI Studio preset against
// the live API, a dozen calls produced several 503 "high demand" and a 429 before a clean
// run. Without a retry those reach the user as a raw `provider: 503 [{"error":...}]`, and
// someone scanning a ball band concludes Cobblr is broken rather than that the free tier
// was busy for a second.
//
// Retries only what is worth retrying: 429 (rate limited) and 502/503/504 (upstream busy).
// A 400 or 401 is a wrong key or a wrong model and will fail identically forever, so
// retrying it just makes the error slower.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 700;
// Total added latency is bounded because a person is usually waiting on this: at worst
// 700ms + 1400ms before giving up. Long enough to ride out a spike, short enough that a
// genuinely down provider still fails promptly.
const RETRY_CAP_MS = 4000;

/** How long to wait before retrying, or null to give up and surface the error. Honours
 *  Retry-After when the provider sends one, since a server's own number beats a guess.
 *  Pure, so the policy is testable without a network. */
export function retryDelayMs(status: number, retryAfter: string | null, attempt: number): number | null {
  if (!RETRY_STATUSES.has(status)) return null;
  if (attempt >= RETRY_ATTEMPTS - 1) return null;
  // Guard the STRING before converting: Number(null) is 0, not NaN, and Number("") is 0
  // too. Either would have made "no Retry-After header" mean "retry immediately", which
  // is a tight loop against a provider that just asked us to slow down.
  const secs = typeof retryAfter === "string" && retryAfter.trim() !== "" ? Number(retryAfter) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_CAP_MS);
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
}

export interface CompatPresetOpts {
  id: string;
  label: string;
  describeCredentials: AiProviderDef["describeCredentials"];
  /** Resolve the base URL from credentials (a preset returns its fixed URL). */
  resolveBase: (credentials: Record<string, unknown>) => string;
  /** Gateways with no default model refuse early with a helpful message
   *  instead of relaying an opaque 4xx. */
  requireModel?: boolean;
  /** A model to use when neither the call nor the connection names one. Lets a preset
   *  with a known-good default ship a blank, optional model field. */
  defaultModel?: string;
  /** Step-by-step for getting this provider's credentials, shown in the UI. */
  setup?: AiProviderDef["setup"];
  /** Position in the picker; lower first, and first is the default. */
  rank?: AiProviderDef["rank"];
  /** Extra request headers (e.g. OpenRouter's attribution headers). */
  extraHeaders?: Record<string, string>;
}

/** One OpenAI-v1 provider body, parameterised for shaped presets. */
export function buildCompatProvider(opts: CompatPresetOpts): AiProviderDef {
  const { id, resolveBase, extraHeaders = {} } = opts;
  return {
    id,
    label: opts.label,
    describeCredentials: opts.describeCredentials,
    setup: opts.setup,
    rank: opts.rank,
    capabilities: SUPPORTED,
    // The prompt this adapter INJECTS (absent from `input` for the image
    // capabilities) joins the cache key — so editing a prompt actually invalidates
    // the replies generated by the old one. See prompt-fingerprint.ts.
    promptFingerprint,
    invoke: async (ctx) => {
      const base = resolveBase(ctx.credentials);
      const model = effectiveModel(ctx.model, ctx.credentials, opts.defaultModel);
      if (opts.requireModel && (!model || model === "default")) {
        throw new Error(`${id}: set a model on the connection (e.g. anthropic/claude-sonnet-5)`);
      }
      // Transit: direct = SSRF-guarded pinned fetch; bridge = the request rides
      // the user's dial-out edge relay and the bridge does the LAN call (e.g.
      // LM Studio on their desk). See ./edge-transit.ts.
      const bridged = viaBridge(ctx.credentials);
      const pin = bridged ? null : await assertSafeAiEndpoint(base, platform().ai.getEndpointPolicy());
      const headers = { "content-type": "application/json", ...extraHeaders, ...authHeadersFor(ctx.credentials) };
      const once = (path: string, init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string }): Promise<PinnedResponse> =>
        bridged
          ? edgeFetch(edgeKeyFor(ctx.credentials, ctx.orgId), base, path, init)
          : pinnedFetch(`${base}${path}`, pin!, init);
      // One seam, so every capability (chat, embed, the image ones) gets the retry
      // rather than whichever call site remembered to ask for it. The body is untouched
      // until after the last attempt, so retrying a streamed response is safe here.
      const call = async (
        path: string,
        init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string },
      ): Promise<PinnedResponse> => {
        let res = await once(path, init);
        for (let attempt = 0; !res.ok; attempt++) {
          // PinnedResponse deliberately exposes only ok/status/text/json, so there is no
          // Retry-After to read. Widening that SSRF-facing type for a backoff hint is a
          // bad trade; retryDelayMs still takes the parameter so honouring the header is
          // a one-line change if the response type ever carries them.
          const wait = retryDelayMs(res.status, null, attempt);
          if (wait == null) return res;
          await new Promise((r) => setTimeout(r, wait));
          res = await once(path, init);
        }
        return res;
      };
      switch (ctx.capability) {
        case "embed-text": {
          const res = await call("/embeddings", {
            method: "POST",
            headers,
            body: JSON.stringify({ model, input: String(ctx.input.text ?? "") }),
          });
          if (!res.ok) throw new Error(`${id}: ${res.status} ${await res.text()}`);
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
        case "rank-images":
        case "extract-text":
        case "match-to-catalog": {
          const body: Record<string, unknown> = {
            model,
            messages: buildMessages(ctx.capability, ctx.input),
          };
          // Native tool-calling for chat: forward the neutral tool defs. A
          // server that doesn't support tools 4xxes on the field — retried
          // once without them (graceful no-tools degrade for local models).
          const toolDefs = ctx.capability === "chat" ? toolsOf(ctx.input) : null;
          if (toolDefs) body.tools = openAiToolsOf(toolDefs);
          // Stream when somebody is watching AND there are no tools in play:
          // a tool call arrives as its own delta shape, and half-parsing one
          // to show it typing is a way to run the wrong tool. A tool-using
          // round is short anyway; it is the long prose answer that needs to
          // show up as it is written.
          const streamText = ctx.capability === "chat" && typeof ctx.onDelta === "function" && !toolDefs;
          if (streamText) body.stream = true;
          // MCP tool relay (a Claude-subscription bridge behind the OpenAI wire):
          // forward the per-request grant so the bridge spawns `claude -p
          // --mcp-config`. A real OpenAI-compatible server ignores this field.
          const mcpRelay = (ctx.input as Record<string, unknown>).mcp;
          if (ctx.capability === "chat" && mcpRelay && typeof mcpRelay === "object") body.mcp = mcpRelay;
          // response_format json_object is OpenAI-specific; local servers vary.
          // The JSON-shaped prompts already instruct the model, and every
          // consumer robust-parses (parseJsonReply) — so it is NOT sent by
          // default. A caller that hands over an explicit output_schema (the
          // builder) gets it forwarded as a json_schema constraint: it is the
          // one case where the shape matters more than the widest server set,
          // and a server that rejects the field is retried without it below.
          const outputSchema = (ctx.input as Record<string, unknown>).output_schema;
          const constrained = ctx.capability === "chat" && outputSchema && typeof outputSchema === "object";
          if (constrained) {
            body.response_format = { type: "json_schema", json_schema: { name: "cobblr_output", schema: outputSchema } };
          }
          // SSE arrives in chunks that do not respect line boundaries, so a
          // partial line is held until the rest of it turns up.
          let sseTail = "";
          let streamedText = "";
          const onChunk = streamText
            ? (chunk: string) => {
                sseTail += chunk;
                const lines = sseTail.split("\n");
                sseTail = lines.pop() ?? "";
                for (const line of lines) {
                  const t = line.trim();
                  if (!t.startsWith("data:")) continue;
                  const payload = t.slice(5).trim();
                  if (!payload || payload === "[DONE]") continue;
                  try {
                    const frame = JSON.parse(payload) as {
                      choices?: Array<{ delta?: { content?: string } }>;
                    };
                    const piece = frame.choices?.[0]?.delta?.content;
                    if (typeof piece === "string" && piece) {
                      streamedText += piece;
                      ctx.onDelta?.(piece);
                    }
                  } catch {
                    /* a frame we cannot read is a frame we do not need */
                  }
                }
              }
            : undefined;

          let res = await call("/chat/completions", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            ...(onChunk ? { onChunk } : {}),
          });
          if (!res.ok && constrained && res.status >= 400 && res.status < 500) {
            // A server that does not speak json_schema says so with a 4xx; the
            // prompt already asks for the shape, so drop the constraint and go on.
            await res.text().catch(() => "");
            delete body.response_format;
            res = await call("/chat/completions", { method: "POST", headers, body: JSON.stringify(body), ...(onChunk ? { onChunk } : {}) });
          }
          if (!res.ok && toolDefs) {
            const errText = await res.text();
            if (!looksLikeNoToolSupport(res.status, errText)) throw new Error(`${id}: ${res.status} ${errText}`);
            delete body.tools;
            res = await call("/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
          }
          if (!res.ok) throw new Error(`${id}: ${res.status} ${await res.text()}`);
          if (streamText) {
            // A streamed body is SSE frames, not one JSON object. Everything
            // needed was collected on the way past.
            if (!streamedText.trim()) throw new Error(`${id}: the stream carried no text`);
            return { result: { role: "assistant", content: streamedText }, input_tokens: 0, output_tokens: 0 };
          }
          const out = (await res.json()) as {
            choices: Array<{
              message: {
                role: string;
                content: string | null;
                tool_calls?: Array<
                  { id?: string; function?: { name?: string; arguments?: unknown } } & Record<string, unknown>
                >;
              };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const msg = out.choices[0]?.message ?? { role: "assistant", content: "" };
          const calls = parseOpenAiToolCalls(msg);
          return {
            result: {
              role: msg.role ?? "assistant",
              content: stripLeakedReasoning(msg.content ?? ""),
              ...(calls ? { tool_calls: calls } : {}),
            },
            input_tokens: out.usage?.prompt_tokens ?? 0,
            output_tokens: out.usage?.completion_tokens ?? 0,
            cost_cents: 0,
          };
        }
        default:
          throw new Error(`${id}: capability ${ctx.capability} not implemented`);
      }
    },
    testConnection: async (credentials) => {
      try {
        const base = resolveBase(credentials);
        const headers = { ...extraHeaders, ...authHeadersFor(credentials) };
        let res: PinnedResponse;
        if (viaBridge(credentials)) {
          res = await edgeFetch(edgeKeyFor(credentials), base, "/models", { headers });
        } else {
          const pin = await assertSafeAiEndpoint(base, platform().ai.getEndpointPolicy());
          res = await pinnedFetch(`${base}/models`, pin, { headers });
        }
        if (!res.ok) return { ok: false, error: `status ${res.status}` };
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        // The full list travels back, not just a preview string. Validating the key IS a
        // model-list request, so the list is already in hand: throwing it away and then
        // asking the user to type an exact model name is work nobody needed to do. Ids
        // keep the provider's own order and are not filtered here — which models suit a
        // capability is the caller's judgement, not this adapter's.
        const models = (body.data ?? []).map((m) => m.id).filter((x) => typeof x === "string");
        return {
          ok: true,
          models,
          detail: models.length ? `serving ${models.length} model(s)` : undefined,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  };
}

export function register(): void {
  platform().ai.registerProvider(
    buildCompatProvider({
      id: "openai-compat",
      label: "OpenAI-compatible (LM Studio, vLLM, …)",
      describeCredentials: () => ({
        base_url: {
          label: "Base URL (e.g. http://192.168.1.50:1234/v1, LM Studio's local server)",
          secret: false,
        },
        api_key: {
          label: "API key (optional. LM Studio needs none; gateways need one)",
          secret: true,
        },
        model: {
          label: "Model (optional. Leave blank for LM Studio; gateways/vLLM need the exact name)",
          secret: false,
        },
        mcp_relay: {
          label: "How this AI runs tools",
          secret: false,
          choices: [
            { value: "", label: "Returns tool calls for Cobblr to run (standard)" },
            { value: "bridge", label: "Runs tools itself. Give it read-only workspace access via MCP" },
          ],
        },
        ...TRANSIT_FIELD,
      }),
      resolveBase: baseOf,
    }),
  );
}
