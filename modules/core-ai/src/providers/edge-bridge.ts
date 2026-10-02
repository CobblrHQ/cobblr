// "Local AI (via edge bridge)" — a credential-less provider that reaches an
// Ollama-API endpoint running on the WORKSPACE's own device through a live edge
// channel, instead of fetching a URL.
//
// Why it exists: on a hosted instance, SSRF policy (correctly) blocks a BYO
// Ollama URL that points at a private / loopback / tailnet address — and a user
// behind NAT has no public URL anyway. The edge bridge inverts the direction:
// the user's agent dials the cloud and holds the pipe open (see platform().edge
// + the proprietary relay), so the cloud routes the request DOWN that pipe to
// localhost on their device. No public URL, no SSRF surface — the cloud never
// dials inward. The request bodies are plain Ollama HTTP (the agent forwards
// them verbatim to the local target), so a local Ollama OR the ollama-claude
// bridge both just work.
//
// Added as a PERSONAL connection (/me/connections): the channel is keyed by the
// connecting USER, so one agent connection serves every workspace the user has
// routed it to. The personal-connections resolver injects the channel owner's
// id as `__connection_user_id` into the credentials bag; this provider routes
// to that user's live edge. The `model` string is forwarded verbatim to the
// edge target (a local Ollama uses it literally; the claude bridge maps it to a
// Claude tier), so override it via capability defaults to match your device.

import { EdgeOffline, platform, type AiCapability, type EdgeRequest, type EdgeResponse } from "@cobblr/platform-contract";
import { IDENTIFY_PROMPT, measurementContext, visionPromptFor } from "./identify-prompt.js";
import { rankImagesPromptFor } from "./rank-images-prompt.js";
import { toolsOf, turnsOf, openAiToolsOf, ollamaMessagesOf, parseOllamaToolCalls, bridgeUsage } from "./tool-wire.js";
import { promptFingerprint } from "./prompt-fingerprint.js";
import { namesOfTags } from "./ollama-models.js";

/** The personal-connections resolver injects the channel owner's user id here. */
const CONNECTION_USER_KEY = "__connection_user_id";
/** A 16x16 solid red square, the picture the connection test asks about. */
const RED_SQUARE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4IyJCEmIY1TCqYfhqAAACcQQQFwFJQgAAAABJRU5ErkJggg==";

export const EDGE_BRIDGE_ID = "edge-bridge";

export const SUPPORTED: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {
  // sonnet / opus / haiku are the Claude CLI's own aliases and pass straight
  // through the bridge (its /models lists nothing; the name goes to `claude
  // -p --model`). Opus for a change is a real choice, and the chat's model
  // pill is where it gets made.
  // A full id pins one model; an alias is whatever the bridge's CLI calls its
  // newest of that tier. Both are offered: "Sonnet 5.5" means that model
  // even after a newer Sonnet ships.
  chat: { models: ["sonnet", "claude-sonnet-5-5", "opus", "haiku", "llama3.2", "qwen2.5"], defaultModel: "sonnet" },
  // Never haiku for a plan that deletes or reshapes.
  "plan-changes": { models: ["sonnet", "claude-sonnet-5-5", "opus"], defaultModel: "sonnet" },
  "design-workspace": { models: ["opus", "sonnet", "haiku", "llama3.2", "qwen2.5"], defaultModel: "sonnet" },
  summarise: { models: ["sonnet", "llama3.2", "qwen2.5"], defaultModel: "sonnet" },
  "classify-image": { models: ["sonnet", "llava", "llama3.2-vision"], defaultModel: "sonnet" },
  "extract-text": { models: ["sonnet", "llava", "llama3.2-vision"], defaultModel: "sonnet" },
  "identify-image": { models: ["sonnet", "llava", "llama3.2-vision"], defaultModel: "sonnet" },
  "identify-glance": { models: ["sonnet", "llava", "llama3.2-vision"], defaultModel: "sonnet" },
  "split-image": { models: ["sonnet", "llava", "llama3.2-vision"], defaultModel: "sonnet" },
  "rank-images": { models: ["sonnet", "llava", "llama3.2-vision"], defaultModel: "sonnet" },
  // Sonnet, never haiku: a document's values are kept.
  "document-read": { models: ["sonnet", "opus", "llama3.2-vision"], defaultModel: "sonnet" },
  "match-to-catalog": { models: ["sonnet", "llama3.2", "qwen2.5"], defaultModel: "sonnet" },
  "embed-text": { models: ["nomic-embed-text", "mxbai-embed-large"], defaultModel: "nomic-embed-text" },
};

/** How long we wait for a bridge to answer.
 *
 *  Three timeouts sit in a line and they have to NEST, innermost shortest:
 *
 *      bridge 300s  <  us 315s  <  edge relay 330s
 *
 *  Get the order wrong and you throw away work. We asked for 120s while the
 *  reference bridge runs to 300s, so a tool-using chat (~180s) finished and we
 *  had already recorded "edge request timed out" — 11 of 36 chat calls measured
 *  on prod, every one of them successful bridge-side.
 *
 *  Make them EQUAL and you throw away the explanation instead: at t=300 the
 *  bridge starts returning its classified reason ("resting until…", "needs
 *  login") while the relay aborts the socket, and the bare timeout usually wins
 *  the race. Sitting above the bridge and below the relay means the innermost
 *  timeout always fires first, so the message that reaches the user is the one
 *  that says why. */
const BRIDGE_SELF_TIMEOUT_MS = 300_000;
/** The relay clamps with Math.min(timeoutMs, RELAY_MAX_TIMEOUT_MS); asking for
 *  more than it allows is silently reduced, so this bound is real. */
const RELAY_CLAMP_MS = 330_000;
export const EDGE_TIMEOUT_MS = 315_000;
export { BRIDGE_SELF_TIMEOUT_MS, RELAY_CLAMP_MS };

// The bridge fronts a single-process `claude -p` agent. A bulk scan fans 15+ AI
// calls (one identify + one matchmaker per item) at it at once and it answers
// 502/503 under that load — which surfaced as failed identifies (→ raw heuristic
// names) and scary "Non-JSON response (502)" notes. Two guards below: a per-
// channel in-flight cap that queues excess calls, and a transient-status retry.
const MAX_INFLIGHT_PER_CHANNEL = 3;
const TRANSIENT = new Set([429, 502, 503, 504]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const channelLoad = new Map<string, { inflight: number; waiters: Array<() => void> }>();
async function acquire(key: string): Promise<void> {
  let st = channelLoad.get(key);
  if (!st) {
    st = { inflight: 0, waiters: [] };
    channelLoad.set(key, st);
  }
  if (st.inflight < MAX_INFLIGHT_PER_CHANNEL) {
    st.inflight++;
    return;
  }
  // At capacity: park until release() hands us the slot (inflight stays put).
  await new Promise<void>((resolve) => st!.waiters.push(resolve));
}
function release(key: string): void {
  const st = channelLoad.get(key);
  if (!st) return;
  const next = st.waiters.shift();
  if (next) next(); // hand the slot to the next waiter without touching inflight
  else st.inflight--;
}

// The edge agent long-polls; between poll cycles the channel is momentarily
// unheld, so platform().edge.send throws EdgeOffline. That's transient (the
// agent re-polls within seconds), and surfacing it as a hard AI failure made the
// matchmaker drop to its "no AI" keyword note while AI was connected. So those
// are retried, a touch more patiently than the gateway retries. This used to
// match the error's TEXT, which the kernel had long since reworded, so the
// retry never fired; the type cannot drift that way.

/** Route one Ollama-shaped POST down the workspace's edge channel. The agent
 *  forwards `body` verbatim to its local target and returns the parsed reply.
 *  Mirrors the ollama provider's "don't echo the upstream body on error" rule —
 *  the status is enough to diagnose without an exfil channel. Concurrency-capped
 *  per channel + retries transient gateway codes AND a momentarily-disconnected
 *  edge channel, with backoff. */
async function edgePost(channelKey: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  return edgeCall(channelKey, { path, method: "POST", body, timeoutMs: EDGE_TIMEOUT_MS });
}

/** The same, for a read: what the bridge's own target says it serves. */
async function edgeGet(channelKey: string, path: string): Promise<Record<string, unknown>> {
  return edgeCall(channelKey, { path, method: "GET", timeoutMs: EDGE_TIMEOUT_MS });
}

async function edgeCall(channelKey: string, req: EdgeRequest): Promise<Record<string, unknown>> {
  await acquire(channelKey);
  try {
    let lastStatus = 0;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(700 * 2 ** (attempt - 1)); // 0.7s, 1.4s, 2.8s
      let res: EdgeResponse;
      try {
        res = await platform().edge.send(channelKey, req);
      } catch (e) {
        lastErr = e;
        // Channel momentarily unregistered (poll gap / just reaped / re-registering)
        // → wait for the agent's next poll. A real send error is not papered over.
        if (e instanceof EdgeOffline) continue;
        throw e;
      }
      if (res.status >= 200 && res.status < 300) return (res.body ?? {}) as Record<string, unknown>;
      lastStatus = res.status;
      if (!TRANSIENT.has(res.status)) break; // a real error — don't waste retries
    }
    if (lastStatus) throw new Error(`edge bridge: ${lastStatus}`);
    throw lastErr ?? new Error("edge bridge: unavailable");
  } finally {
    release(channelKey);
  }
}

/** The edge channel key = the connection owner's user id, injected by the
 *  personal-connections resolver. Absent → this provider was used outside a
 *  personal Connection, which it doesn't support. */
function channelKeyOf(credentials: Record<string, unknown>): string {
  const k = credentials[CONNECTION_USER_KEY];
  if (typeof k !== "string" || !k) {
    throw new Error("edge bridge: add it as a personal Connection (/me/connections) and connect the agent");
  }
  return k;
}

export function register(): void {
  platform().ai.registerProvider({
    id: EDGE_BRIDGE_ID,
    label: "Local AI (via edge bridge)",
    // Near-credential-less: routing is by the connected edge, keyed on the user
    // who owns the personal Connection (injected as __connection_user_id). The one
    // optional field is a GENERIC capability declaration — does the backend return
    // tool calls, or run tools itself? An agent-style backend (it executes tools
    // internally and only returns text) gets workspace tools relayed to it via MCP
    // (read-only) instead; same seam as the ollama/openai-compat providers.
    describeCredentials: () => ({
      mcp_relay: {
        label: "How this AI runs tools",
        secret: false,
        choices: [
          { value: "", label: "Returns tool calls for Cobblr to run (standard)" },
          { value: "bridge", label: "Runs tools itself. Give it read-only workspace access via MCP" },
        ],
      },
    }),
    // NOT a zero-config default: it only works once an edge agent is connected
    // and routed via a personal Connection. Excluding it from auto-select keeps a
    // no-provider workspace's degrade path a clean no_ai_provider.
    autoSelectable: false,
    modelNotes: {
      sonnet: { label: "Sonnet (newest)", short: "Sonnet", note: "The newest Sonnet the bridge's Claude CLI knows" },
      "claude-sonnet-5-5": { label: "Sonnet 5.5", short: "Sonnet 5.5", note: "Pinned: stays on 5.5 when a newer Sonnet ships" },
      opus: { label: "Opus (newest)", short: "Opus", note: "The newest Opus the bridge's Claude CLI knows" },
      haiku: { label: "Haiku (newest)", short: "Haiku" },
    },
    checksPhotosInTest: true,
    capabilities: SUPPORTED,
    // The prompt this adapter INJECTS (absent from `input` for the image
    // capabilities) joins the cache key — so editing a prompt actually invalidates
    // the replies generated by the old one. See prompt-fingerprint.ts.
    promptFingerprint,
    invoke: async (ctx) => {
      const channelKey = channelKeyOf(ctx.credentials);
      switch (ctx.capability) {
        case "embed-text": {
          const input = String(ctx.input.text ?? "");
          const body = await edgePost(channelKey, "/api/embeddings", {
            model: ctx.model,
            prompt: input,
          });
          const embedding = (body as { embedding?: number[] }).embedding ?? [];
          return { result: { vector: embedding }, cost_cents: 0 };
        }
        // The builder sends a conversation like chat does (no tools), and reads
        // the answer the same way.
        case "design-workspace":
        case "chat":
        case "plan-changes": {
          // Ollama dialect over the tunnel (see tool-wire.ts). Tool defs ride
          // along when supplied; a bridge target that ignores/lacks tools just
          // answers text — the chat loop treats that as a plain reply (graceful
          // degrade until the bridge's OpenAI-v1 migration).
          const messages = ollamaMessagesOf(turnsOf(ctx.input)) as Array<Record<string, unknown>>;
          const system = typeof ctx.input.system === "string" ? ctx.input.system : undefined;
          const toolDefs = toolsOf(ctx.input);
          const req: Record<string, unknown> = {
            model: ctx.model,
            stream: false,
            messages: system ? [{ role: "system", content: system }, ...messages] : messages,
          };
          if (toolDefs) req.tools = openAiToolsOf(toolDefs);
          // MCP tool relay: forward the per-request grant so the local claude
          // bridge (behind the edge agent) can read this workspace via MCP. A
          // real local Ollama ignores this unknown field. Rides verbatim through
          // the edge relay + the AI-relay agent (both forward the body as-is).
          const mcpRelay = (ctx.input as Record<string, unknown>).mcp;
          if (mcpRelay && typeof mcpRelay === "object") req.mcp = mcpRelay;
          let body: Record<string, unknown>;
          try {
            body = await edgePost(channelKey, "/api/chat", req);
          } catch (err) {
            // A 4xx that names tools = the local target rejects the field —
            // retry once without them rather than failing the turn.
            if (toolDefs && /tool/i.test((err as Error)?.message ?? "")) {
              delete req.tools;
              body = await edgePost(channelKey, "/api/chat", req);
            } else {
              throw err;
            }
          }
          const m =
            (body as {
              message?: {
                role?: string;
                content?: string;
                tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
              };
            }).message ?? {};
          const calls = parseOllamaToolCalls(m);
          return {
            result: {
              role: m.role ?? "assistant",
              content: m.content ?? "",
              ...(calls ? { tool_calls: calls } : {}),
            },
            ...bridgeUsage(body),
            cost_cents: 0,
          };
        }
        case "summarise": {
          const text = String(ctx.input.text ?? "");
          const lengthHint = String(ctx.input.lengthHint ?? "3 sentences");
          const body = await edgePost(channelKey, "/api/chat", {
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
          const content = (body as { message?: { content?: string } }).message?.content ?? "";
          return { result: { text: content }, cost_cents: 0 };
        }
        case "classify-image":
        case "extract-text":
        case "split-image":
        case "identify-glance":
        case "document-read":
        case "identify-image":
        case "rank-images":
        case "match-to-catalog": {
          // Apply the SAME canonical prompt the OpenAI/Anthropic adapters use for
          // each image capability — the caller (e.g. identifyImage) passes only
          // image_b64, NOT a prompt, so a "Describe this." fallback returned prose
          // the caller's JSON.parse choked on ("no vision provider configured").
          const labels = Array.isArray(ctx.input.labels) ? (ctx.input.labels as string[]) : [];
          const prompt =
            typeof ctx.input.prompt === "string" && ctx.input.prompt.trim()
              ? ctx.input.prompt
              : (ctx.capability === "identify-image" || ctx.capability === "document-read" || ctx.capability === "split-image" || ctx.capability === "identify-glance")
                ? visionPromptFor(ctx.capability, ctx.input)
                : ctx.capability === "rank-images"
                  ? rankImagesPromptFor(ctx.input)
                : ctx.capability === "extract-text"
                  ? "Read all text from the image. Return the text only."
                  : ctx.capability === "classify-image"
                    ? `Classify this image with one of the supplied labels.${labels.length ? `\n\nAllowed labels: ${labels.join(", ")}` : ""}`
                    : ctx.capability === "match-to-catalog"
                      ? `Match the user entity to the best catalog candidate. Reply with JSON ` +
                        `{"matches":[{"candidate_id":string,"confidence":number}]} (desc, top 3).\n\n` +
                        `User entity:\n${JSON.stringify(ctx.input.user_entity ?? {}, null, 2)}\n\n` +
                        `Candidates:\n${JSON.stringify(ctx.input.candidates ?? [], null, 2)}`
                      : "Describe this.";
          const imageB64 = typeof ctx.input.image_b64 === "string" ? ctx.input.image_b64 : null;
          const msg: Record<string, unknown> = { role: "user", content: prompt };
          if (imageB64) msg.images = [imageB64];
          const body = await edgePost(channelKey, "/api/chat", {
            model: ctx.model,
            stream: false,
            format: ctx.capability === "extract-text" ? undefined : "json",
            messages: [msg],
          });
          const content = (body as { message?: { content?: string } }).message?.content ?? "";
          return { result: { text: content }, cost_cents: 0 };
        }
        default:
          throw new Error(`edge bridge: capability ${ctx.capability} not implemented`);
      }
    },
    // The channel is keyed by the connection's OWNER, which the test is
    // handed as __connection_user_id, so the test reaches the same bridge a
    // call would. It used to have none ("gets no workspace"), and every
    // bridge read "Unverified" forever, including one that worked (#3842).
    testConnection: async (credentials) => {
      let channelKey: string;
      try {
        channelKey = channelKeyOf(credentials);
      } catch (err) {
        return { ok: false, reason: "unknown", error: (err as Error).message };
      }
      if (!(await platform().edge.hasChannel(channelKey).catch(() => false))) {
        return { ok: false, reason: "unreachable", error: "The bridge is not connected right now. Start its agent, then test again." };
      }
      const model = typeof credentials.model === "string" && credentials.model.trim() ? credentials.model.trim() : (SUPPORTED.chat?.defaultModel ?? "sonnet");
      let said = "";
      try {
        const body = await edgePost(channelKey, "/api/chat", {
          model,
          stream: false,
          messages: [{ role: "user", content: "Reply with the single word OK." }],
        });
        said = (body as { message?: { content?: string } }).message?.content ?? "";
      } catch (err) {
        return { ok: false, reason: "unreachable", error: (err as Error).message };
      }
      if (!said.trim()) return { ok: false, reason: "unknown", error: "The bridge answered with nothing." };
      // A known picture: a bridge whose backend drops the image answers the
      // question anyway, from nothing, so only naming the colour counts.
      let photos: { read: boolean; said?: string };
      try {
        const body = await edgePost(channelKey, "/api/chat", {
          model,
          stream: false,
          messages: [{ role: "user", content: "What colour is this square? Answer with one word.", images: [RED_SQUARE_PNG] }],
        });
        const answer = (body as { message?: { content?: string } }).message?.content ?? "";
        photos = /\bred\b/i.test(answer) ? { read: true } : { read: false, said: answer.trim() };
      } catch (err) {
        photos = { read: false, said: (err as Error).message };
      }
      return { ok: true, models: [model], photos };
    },
    // What the bridge's target reports (an Ollama-shaped /api/tags): a Claude
    // bridge answers sonnet, opus and haiku, a local Ollama what it pulled.
    listModels: async (credentials) => {
      const channelKey = channelKeyOf(credentials);
      // An agent that is not connected is said at once: the menu waits on
      // this answer, and the send's retries are for a poll gap, not an absence.
      if (!(await platform().edge.hasChannel(channelKey).catch(() => false))) {
        throw new Error("The bridge is not connected right now.");
      }
      const body = await edgeGet(channelKey, "/api/tags");
      return namesOfTags(body);
    },
  });
}
