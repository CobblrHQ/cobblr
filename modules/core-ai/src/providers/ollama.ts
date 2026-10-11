// ollama — local model provider. The workspace points at an Ollama
// HTTP endpoint (default http://ollama:11434 in our docker-compose,
// or http://host.docker.internal:11434 from inside containers, or
// http://localhost:11434 for native runs). Auth is optional: a bare local
// Ollama needs none, but a remote one behind a token-checking reverse
// proxy / tunnel (or the ollama-claude bridge with BRIDGE_TOKEN set) does —
// set the optional `bearer_token` credential and it's sent as
// `Authorization: Bearer …`.

import { assertLocalAiEndpoint, assertLocalAiPin, assertLocalModelName } from "./local-endpoint.js";
import { platform, type AiCapability } from "@cobblr/platform-contract";
import { providerError, providerSentence, reasonFromResponse, reasonFromTransportError, redactSecrets } from "@cobblr/platform-contract/provider-reason";
import { assertSafeAiEndpoint, pinnedFetch, type PinnedResponse } from "../ssrf.js";
import { TRANSIT_FIELD, viaBridge, edgeKeyFor, edgeFetch } from "./edge-transit.js";
import {
  toolsOf,
  turnsOf,
  openAiToolsOf,
  ollamaMessagesOf,
  parseOllamaToolCalls,
  looksLikeNoToolSupport,
  contextWindowFor,
} from "./tool-wire.js";
import { promptFingerprint } from "./prompt-fingerprint.js";
import { visionPromptFor } from "./identify-prompt.js";
import { rankImagesPromptFor } from "./rank-images-prompt.js";
import { namesOfTags, pickInstalledModel } from "./ollama-models.js";
import { servedModelOf } from "@cobblr/platform-contract/ai-models";

/** Optional bearer auth for the endpoint. Returns {} when no token is
 *  configured (a bare local Ollama). A remote endpoint behind a
 *  token-checking proxy/tunnel — or the ollama-claude bridge with
 *  BRIDGE_TOKEN set — gets `Authorization: Bearer <token>`. */
export function authHeadersFor(credentials: Record<string, unknown>): Record<string, string> {
  const t = typeof credentials.bearer_token === "string" ? credentials.bearer_token.trim() : "";
  return t ? { authorization: `Bearer ${t}` } : {};
}

// The menu shown at setup, and the fallback when a workspace names no model.
//
// MEASURED, not remembered (2026-08-25, scripts/bench-ollama*.ts against a real
// box). The previous menu had aged badly in both directions: `llava` is a 2023
// model nobody installs now, and `llama3.2-vision` does not even LOAD on current
// Ollama — "unknown model architecture: 'mllama'", a 500 on every request. Two
// recommendations, both dead ends, and a user with a perfectly good qwen2.5vl
// installed got neither.
//
// Scores from that run (see docs/operations/local-model-bench.md):
//   tools   qwen3:14b 7/8 · qwen3 27B 7/8 (9x slower) · gemma 8B 3/8
//   vision  qwen2.5vl:7b 6/6 · minicpm-v 5/6 · granite3.2-vision:2b 2/6
//
// A name here is a SUGGESTION either way: pickInstalledModel() reads the box's
// own /api/tags when one of these turns out not to be installed.
export const SUPPORTED: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {
  chat: { models: ["qwen3:14b", "qwen3", "granite3.3", "command-r7b", "llama3.2"], defaultModel: "qwen3:14b" },
  // The strongest local chat model, never a small one, for a plan that deletes.
  "plan-changes": { models: ["qwen3:14b", "qwen3"], defaultModel: "qwen3:14b" },
  // Anything that can hold a conversation can be asked to design a workspace;
  // whether it does it WELL is the workspace's choice of model, which is the
  // point of the job having its own id.
  "design-workspace": { models: ["qwen3:14b", "qwen3", "granite3.3", "command-r7b", "llama3.2"], defaultModel: "qwen3:14b" },
  summarise: { models: ["qwen3:14b", "qwen3", "llama3.2"], defaultModel: "qwen3:14b" },
  "classify-image": { models: ["qwen2.5vl", "minicpm-v", "granite3.2-vision"], defaultModel: "qwen2.5vl" },
  // identify-image was MISSING, so a workspace on a direct local Ollama threw
  // "no provider configured for capability identify-image" on every photo scan
  // (and every split) — the whole flagship photo-identify flow was dark for local
  // models. Ollama-over-the-edge-bridge worked only because that adapter declares
  // it. Same vision models as classify-image; same /api/chat + images call below.
  "identify-image": { models: ["qwen2.5vl", "minicpm-v", "granite3.2-vision"], defaultModel: "qwen2.5vl" },
  "identify-glance": { models: ["qwen2.5vl", "minicpm-v", "granite3.2-vision"], defaultModel: "qwen2.5vl" },
  "split-image": { models: ["qwen2.5vl", "minicpm-v", "granite3.2-vision"], defaultModel: "qwen2.5vl" },
  "rank-images": { models: ["qwen2.5vl", "minicpm-v"], defaultModel: "qwen2.5vl" },
  // The strongest vision model on the bench (6/6), not the 2B one.
  "personal-document-read": { models: ["qwen2.5vl", "minicpm-v"], defaultModel: "qwen2.5vl" },
  "document-read": { models: ["qwen2.5vl", "minicpm-v"], defaultModel: "qwen2.5vl" },
  // Reading text off a photo: minicpm-v is built for it and scores level with
  // qwen on the label cases, so it leads here and follows elsewhere.
  "extract-text": { models: ["minicpm-v", "qwen2.5vl", "granite3.2-vision"], defaultModel: "minicpm-v" },
  "embed-text": { models: ["nomic-embed-text", "mxbai-embed-large"], defaultModel: "nomic-embed-text" },
  "match-to-catalog": {
    models: ["qwen3:14b", "qwen3", "qwen2.5vl"],
    defaultModel: "qwen3:14b",
  },
};

/** Capabilities that may let a thinking model think. None does today: every
 *  call the app makes is structured (JSON, tool calls) or short, and a model
 *  left to think spends 25 to 60 s on what takes 1 to 3 s without (#4733). */
const THINKS: ReadonlySet<string> = new Set<string>();

/** Models (per server) that refused the `think` field: an older server, or a
 *  model that has no thinking switch. Asked once, then sent without it. */
const refusesThink = new Set<string>();

/** A reply with nothing in it is a failure another provider may answer, never
 *  "the model had nothing to say" handed to the caller as an answer. */
function emptyReply(model: unknown): Error {
  return providerError("ollama", "busy", `ollama: ${String(model)} answered with nothing`);
}

export function register(): void {
  platform().ai.registerProvider({
    id: "ollama",
    locality: "local",
    freeBackground: true,
    freeBackgroundModel: "llama3.2",
    label: "Ollama (local)",
    // Free and private, but needs hardware, so it follows the one that needs none.
    rank: 20,
    setup: {
      summary:
        "Free, and nothing leaves your machine. Needs a computer that can run the model, " +
        "which for reading photos means a reasonably modern one with plenty of memory.",
      steps: [
        { text: "Install Ollama on the machine that runs Cobblr, or one on the same network.", href: "https://ollama.com/download" },
        // Two models, because the jobs are different and Cobblr routes them
        // separately: reading a photo wants eyes, running an action wants a
        // tool-caller. Both fit a 12 GB card on their own. Measured, not
        // guessed — see docs/operations/local-model-bench.md.
        {
          text:
            "Pull a model that can read images, and one that can run actions. In a terminal: " +
            "ollama pull qwen2.5vl && ollama pull qwen3:14b",
        },
        { text: "Make sure Ollama is reachable from Cobblr. On the same machine that is http://localhost:11434; in Docker it is usually http://ollama:11434." },
        { text: "Put that address below and save. No key is needed." },
      ],
      caveat:
        "A local model is usually less accurate at identifying products than a hosted one, " +
        "and slower on a machine without a graphics card. The trade is that your photos " +
        "never leave your network.",
    },
    describeCredentials: () => ({
      base_url: {
        label: "Ollama base URL (e.g. http://ollama:11434)",
        secret: false,
      },
      bearer_token: {
        label: "Bearer token (optional, for a remote/proxied endpoint; sent as Authorization: Bearer …)",
        secret: true,
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
    capabilities: SUPPORTED,
    // The prompt this adapter INJECTS (absent from `input` for the image
    // capabilities) joins the cache key — so editing a prompt actually invalidates
    // the replies generated by the old one. See prompt-fingerprint.ts.
    promptFingerprint,
    invoke: async (ctx) => {
      // Every failure carries the reason Ollama gave ("model not found" is a
      // model, not a dead server), with any credential blanked from the message.
      const failed = async (res: PinnedResponse) => {
        const body = await res.text().catch(() => "");
        return providerError("ollama", reasonFromResponse(res.status, body), redactSecrets(`ollama: ${res.status} ${body}`, Object.values(ctx.credentials)), res.status);
      };
      const base = String(ctx.credentials.base_url ?? "http://ollama:11434").replace(/\/$/, "");
      if (ctx.privacy === "personal") assertLocalAiEndpoint(base, ctx.credentials, ctx.model);
      // Transit: direct = SSRF-guarded fetch (block internal/loopback/metadata
      // per deployment policy, pin the connection — see ../ssrf.ts). Bridge =
      // the request rides the user's dial-out edge relay and the bridge does
      // the LAN call, so the guard doesn't apply (the cloud never dials the
      // address). See ./edge-transit.ts.
      const bridged = viaBridge(ctx.credentials);
      const pin = bridged ? null : await assertSafeAiEndpoint(base, platform().ai.getEndpointPolicy());
      if (ctx.privacy === "personal") assertLocalAiPin(pin);
      const authHeaders = authHeadersFor(ctx.credentials);
      const call = (path: string, init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string }): Promise<PinnedResponse> => {
        if (ctx.privacy === "personal" && init.body) {
          const model = String((JSON.parse(init.body) as { model?: unknown }).model || "");
          assertLocalModelName(model);
        }
        return bridged
          ? edgeFetch(edgeKeyFor(ctx.credentials, ctx.orgId), base, path, { ...init, ...(ctx.privacy === "personal" ? { privacy: ctx.privacy, requiredFeatures: ["no-redirects"] } : {}) })
          : pinnedFetch(`${base}${path}`, pin!, init);
      };

      /** The model we were told to use is not on this box. Rather than fail with
       *  "model not found" — which reads as the app being broken — ask what IS
       *  installed and use the best fit. The shipped menu (llama3.2, llava) is a
       *  guess about somebody else's disk: a real box measured 2026-08-25 had
       *  neither, so every photo scan 404ed while a capable model sat idle. */
      const retryOnMissingModel = async (
        res: PinnedResponse,
        reqBody: Record<string, unknown>,
        path = "/api/chat",
      ): Promise<PinnedResponse> => {
        if (res.ok || res.status !== 404) return res;
        const tags = await call("/api/tags", { method: "GET", headers: authHeaders });
        if (!tags.ok) return res;
        const installed = (((await tags.json()) as { models?: Array<{ name?: string }> }).models ?? [])
          .map((m) => String(m.name ?? ""))
          .filter(Boolean);
        const picked = pickInstalledModel(ctx.capability, installed);
        // Nothing suitable: say what the box HAS, because "model not found" for a
        // name the user never chose is unanswerable.
        if (!picked) {
          throw new Error(
            `ollama: no installed model can do ${ctx.capability}` +
              (installed.length ? ` (installed: ${installed.slice(0, 6).join(", ")})` : " (no models installed)"),
          );
        }
        if (picked === reqBody.model) return res;
        console.warn(`[ollama] ${String(reqBody.model)} is not installed; using ${picked} for ${ctx.capability}`);
        return call(path, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ ...reqBody, model: picked }),
        });
      };
      /** POST /api/chat with the thinking switch set: off unless this
       *  capability opts in. A server or model that refuses the field is asked
       *  again once without it, and remembered. */
      const chatCall = async (reqBody: Record<string, unknown>): Promise<PinnedResponse> => {
        const key = `${base}|${String(reqBody.model)}`;
        if (!refusesThink.has(key)) reqBody.think = THINKS.has(ctx.capability);
        const post = () =>
          call("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders },
            body: JSON.stringify(reqBody),
          });
        let res = await post();
        // A refusal of the field is a 400 that names it. Reading the body spends
        // it, so only a 400 is read; a 404 (missing model) stays whole for
        // retryOnMissingModel.
        if (res.status === 400 && "think" in reqBody) {
          const why = await res.text().catch(() => "");
          if (!/think/i.test(why)) {
            // Not about thinking: hand the refusal on whole, body included,
            // for the no-tools retry and the error that names the reason.
            const status = res.status;
            return { ok: false, status, text: async () => why, json: async () => JSON.parse(why) as unknown };
          }
          refusesThink.add(key);
          delete reqBody.think;
          res = await post();
        }
        return retryOnMissingModel(res, reqBody);
      };
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
          if (!res.ok) throw await failed(res);
          const body = (await res.json()) as { embedding: number[] };
          return { result: { vector: body.embedding }, cost_cents: 0 };
        }
        // The builder sends a conversation like chat does (no tools), and reads
        // the answer the same way.
        case "design-workspace":
        case "chat":
        case "plan-changes": {
          // Tool-aware turn mapping (Ollama's dialect of the neutral wire — see
          // tool-wire.ts: arguments are objects, results match by order).
          const messages = ollamaMessagesOf(turnsOf(ctx.input)) as Array<Record<string, unknown>>;
          // Honour a first-class `system` prompt (chat.ts passes it here, not as
          // a role:"system" message). Every adapter must read input.system; this
          // one was missed when delivery moved there, silently dropping the
          // workspace prompt for direct-Ollama chat.
          const system = typeof ctx.input.system === "string" ? ctx.input.system : undefined;
          const toolDefs = toolsOf(ctx.input);
          const reqBody: Record<string, unknown> = {
            model: ctx.model,
            messages: system ? [{ role: "system", content: system }, ...messages] : messages,
            stream: false,
          };
          // Ollama takes OpenAI-shaped tool defs; a model without tool support
          // 4xxes on the field — retried once without them (graceful degrade).
          if (toolDefs) reqBody.tools = openAiToolsOf(toolDefs);
          // MCP tool relay (a Claude-subscription bridge, not a real Ollama):
          // forward the per-request `{token, workspace}` grant so the bridge can
          // spawn `claude -p --mcp-config` against this workspace. A real Ollama
          // ignores this unknown field. See core-ai's ai.ts invoke().
          const mcpRelay = (ctx.input as Record<string, unknown>).mcp;
          if (mcpRelay && typeof mcpRelay === "object") reqBody.mcp = mcpRelay;
          // A caller that knows the SHAPE it needs back (the builder) hands it
          // over as a JSON schema, and ollama constrains decoding to it: a
          // non-JSON reply or a wrapper missing its parts becomes impossible to
          // emit, rather than something a prompt asks nicely for and a parser
          // then salvages. Structure stops being the model's job.
          const outputSchema = outputSchemaOf(ctx.input);
          if (outputSchema) reqBody.format = outputSchema;
          // Ask for a window big enough to hold what we are sending. Without
          // this, ollama's small default truncates the tool schemas out of the
          // prompt and cuts the answer off mid-sentence — see contextWindowFor.
          reqBody.options = { num_ctx: contextWindowFor(JSON.stringify(reqBody).length) };
          let res = await chatCall(reqBody);
          if (!res.ok && toolDefs) {
            const errText = await res.text().catch(() => "");
            if (looksLikeNoToolSupport(res.status, errText)) {
              delete reqBody.tools;
              res = await call("/api/chat", {
                method: "POST",
                headers: { "content-type": "application/json", ...authHeaders },
                body: JSON.stringify(reqBody),
              });
            }
          }
          // Don't echo the upstream body — for a read-SSRF that body is the
          // exfil channel; the status alone is enough to diagnose.
          if (!res.ok) throw await failed(res);
          const body = (await res.json()) as {
            message: {
              role: string;
              content: string;
              tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
            };
            prompt_eval_count?: number;
            eval_count?: number;
            model?: unknown;
          };
          const calls = parseOllamaToolCalls(body.message ?? {});
          if (!calls && !String(body.message?.content ?? "").trim()) throw emptyReply(reqBody.model);
          return {
            result: {
              role: body.message?.role ?? "assistant",
              content: body.message?.content ?? "",
              ...(calls ? { tool_calls: calls } : {}),
            },
            input_tokens: body.prompt_eval_count,
            output_tokens: body.eval_count,
            cost_cents: 0,
            // The model that answered: a missing one is swapped for an
            // installed one above, and the log says which.
            served_model: servedModelOf(body.model),
          };
        }
        case "summarise": {
          const text = String(ctx.input.text ?? "");
          const lengthHint = String(ctx.input.lengthHint ?? "3 sentences");
          const res = await chatCall({
            model: ctx.model,
            stream: false,
            messages: [
              {
                role: "system",
                content: `Summarise the user's text in ${lengthHint}. Output plain prose, no preamble.`,
              },
              { role: "user", content: text },
            ],
          });
          // Don't echo the upstream body — for a read-SSRF that body is the
          // exfil channel; the status alone is enough to diagnose.
          if (!res.ok) throw await failed(res);
          const body = (await res.json()) as { message: { content: string }; model?: unknown };
          if (!String(body.message?.content ?? "").trim()) throw emptyReply(ctx.model);
          return { result: { text: body.message.content }, cost_cents: 0, served_model: servedModelOf(body.model) };
        }
        case "split-image":
        case "identify-glance":
        case "personal-document-read":
        case "document-read":
        case "identify-image":
        case "rank-images":
        case "classify-image":
        case "extract-text":
        case "match-to-catalog": {
          // Image-or-text generic chat call. Caller passes
          // input.prompt + optional input.image_b64. Returned as
          // raw text the caller parses (JSON for classify/match).
          //
          // identify-image callers do NOT pass input.prompt — the prompt is
          // server-side (IDENTIFY_PROMPT, or detectSplitItems' own). Resolve it
          // through the SAME shared function the OpenAI/Anthropic adapters use, so
          // all three send byte-identical text and the cache fingerprint agrees.
          const prompt =
            (ctx.capability === "identify-image" || ctx.capability === "document-read" || ctx.capability === "personal-document-read" || ctx.capability === "split-image" || ctx.capability === "identify-glance")
              ? visionPromptFor(ctx.capability, ctx.input)
              : ctx.capability === "rank-images"
                ? rankImagesPromptFor(ctx.input)
                : String(ctx.input.prompt ?? "");
          const imageB64 = typeof ctx.input.image_b64 === "string" ? ctx.input.image_b64 : null;
          const msg: Record<string, unknown> = { role: "user", content: prompt };
          if (imageB64) msg.images = [imageB64];
          const visionBody: Record<string, unknown> = {
            model: ctx.model,
            stream: false,
            // The caller's shape when it gave one (#5790): Ollama then cannot
            // answer in any other. Plain text where the prompt asks for text
            // or labelled lines (an OCR read, a personal document's fields).
            format: outputSchemaOf(ctx.input) ?? (ctx.capability === "extract-text" || ctx.capability === "personal-document-read" ? undefined : "json"),
            messages: [msg],
          };
          const res = await chatCall(visionBody);
          // Don't echo the upstream body — for a read-SSRF that body is the
          // exfil channel; the status alone is enough to diagnose.
          if (!res.ok) throw await failed(res);
          const body = (await res.json()) as { message: { content: string }; model?: unknown };
          if (!String(body.message?.content ?? "").trim()) throw emptyReply(ctx.model);
          return { result: { text: body.message.content }, cost_cents: 0, served_model: servedModelOf(body.model) };
        }
        default:
          throw new Error(`ollama: capability ${ctx.capability} not implemented`);
      }
    },
    // What this box has pulled: the menu offers exactly that, never the
    // type's suggestions (a box with qwen3 and gemma4 has no llama3.2).
    listModels: async (credentials) => {
      const base = String(credentials.base_url ?? "http://ollama:11434").replace(/\/$/, "");
      let res: PinnedResponse;
      if (viaBridge(credentials)) {
        res = await edgeFetch(edgeKeyFor(credentials), base, "/api/tags", { headers: authHeadersFor(credentials) });
      } else {
        const pin = await assertSafeAiEndpoint(base, platform().ai.getEndpointPolicy());
        res = await pinnedFetch(`${base}/api/tags`, pin, { headers: authHeadersFor(credentials) });
      }
      if (!res.ok) throw new Error(providerSentence(reasonFromResponse(res.status, await res.text().catch(() => "")), { provider: "ollama" }));
      return namesOfTags(await res.json());
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
        if (res.ok) return { ok: true };
        const body = await res.text().catch(() => "");
        const reason = reasonFromResponse(res.status, body);
        return { ok: false, reason, error: providerSentence(reason, { provider: "ollama" }) };
      } catch (err) {
        const reason = reasonFromTransportError(err);
        return { ok: false, reason, error: providerSentence(reason, { provider: "ollama" }), detail: redactSecrets((err as Error).message, Object.values(credentials)) };
      }
    },
  });
}

/** A caller's output schema (#5790), when it gave one. */
function outputSchemaOf(input: Record<string, unknown>): Record<string, unknown> | null {
  const s = input.output_schema;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : null;
}
