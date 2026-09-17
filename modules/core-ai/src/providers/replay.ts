// Replay provider: a recorded model, for tests.
//
// CI has no AI provider, so every chat-shaped test ended one of two ways:
// asserting the failure path, or spending real tokens against a live model.
// Both are the wrong tool for "does the loop, the turn store and the widget
// behave" — those questions do not depend on what a model would say, only on
// what a model DOES say, which is a small, finite set of shapes: a plain reply,
// a tool call, a second round after the result comes back.
//
// So this provider replays CASSETTES: JSON files describing what the model
// answers per round of the agent loop, keyed by the user's message. It runs the
// real loop, the real tool registry, the real persisted turn — only the model
// call is canned. No network, no key, no cost, deterministic.
//
// It is registered ONLY when COBBLR_AI_REPLAY_DIR names a directory. On any
// real instance the variable is unset and this file is inert. And it is
// OPT-IN per workspace: a test installs it (POST /providers with
// provider_id "replay"); it never auto-selects, so tests that assert the
// no-provider path keep the world they were written for.
//
// Cassette format (one file per scenario, any name, *.json):
//   {
//     "match": "how many racks",           // substring of the LAST user message
//     "rounds": [                          // one entry per callModel(), in order
//       { "tool_calls": [ { "name": "list_records", "args": { "kind": "core-locations:location" } } ] },
//       { "content": "You have 12 racks under Den." }
//     ]
//   }
// A round with tool_calls makes the loop run those tools (for real) and call
// again; a round with content ends the turn. Rounds are consumed per turn: the
// Nth callModel of a turn gets rounds[N]. If a turn asks for more rounds than
// the cassette has, the last one repeats, so a cassette never strands a loop.
//
// A fallback cassette with "match": "*" answers anything unmatched with a
// plain reply, so a test that only cares about plumbing needs no cassette of
// its own.
//
// A round may point INTO the previous tool result. A recorded model that
// searched and then acted on what it found carries the id of a record that
// exists only in the workspace it was recorded against; in a fresh test
// workspace that id matches nothing. So a string argument of the form
// "$prev.<path>" is read from the JSON of the most recent tool result when
// the round is played: "$prev.data.items[0].id" is the first hit of the
// search the round before, and "$result.list_records.data.items[0].id" is
// the first hit of the most recent list_records whatever came after it (a
// bounced write leaves its own tool result on top). This is what lets a
// cassette do what the live model did with two CubePros (#3154): search,
// take the first hit, act. The longest matching `match` wins, so a cassette
// for the re-ask "label on the cubepro #9" beats the one for the sentence
// it extends.
//
// IMAGE cassettes, for the scan surfaces (identify-image, classify-image,
// extract-text), in the `images/` subdirectory of the cassette dir: a photo
// has no "last user message" to match, so an image cassette is keyed by a
// PERCEPTUAL hash of the image (an 8x8 average hash, 16 hex chars) and answers
// with one canned reply text. Perceptual, not a byte hash: the identify step
// sends the file store's resized "medium" JPEG, never the bytes the test
// uploaded, so a sha256 of the fixture matched nothing (the first CI run of
// this). A resize or a re-encode moves a bit or two of the hash, so a match
// is a Hamming distance of at most HASH_TOLERANCE. Without one, every image
// capability returns a stable, obviously-fake item so a scan test still runs
// end to end. (A subdirectory, because the chat corpus lint holds every file
// beside the chat cassettes to the rounds shape.)
//
//   {
//     "image_ahash": "ffc3818181c3ffff",       // npx tsx scripts/image-cassette-key.mjs <file>
//     "capability": "identify-image",         // optional; omitted = any image capability
//     "reply": "{\"name\":\"Store receipt\",\"observations\":\"A printed receipt\",\"category\":\"receipt\"}"
//   }
//
// Recording new cassettes: `COBBLR_AI_REPLAY_RECORD=<dir>` on an instance with a
// real provider writes one file per turn with the rounds the model actually
// produced. Point it at the SAME directory as COBBLR_AI_REPLAY_DIR and the
// scenario you just ran live replays immediately, with no restart — the
// directory is read per call. That is the whole workflow: run it once against a
// real model, then iterate on it for free.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { platform, type AiCapability } from "@cobblr/platform-contract";
import sharp from "sharp";
import { ProviderError, providerSentence, type ProviderReason } from "@cobblr/platform-contract/provider-reason";
import { turnsOf, type ChatTurn, type ToolCall } from "./tool-wire.js";
import { promptFingerprint } from "./prompt-fingerprint.js";

export const REPLAY_PROVIDER_ID = "replay";

interface Round {
  content?: string;
  tool_calls?: Array<{ name: string; args?: Record<string, unknown> }>;
}
interface Cassette {
  match: string;
  rounds: Round[];
  /** The provider refuses this turn for this reason instead of answering:
   *  the same ProviderError a real adapter throws on a 429 or a bad key, so
   *  a test can drive the refusal path with no key and no network. */
  refuse?: ProviderReason;
  file: string;
}

const REASONS: ReadonlySet<string> = new Set(["invalid_key", "quota", "model_unavailable", "unreachable", "unknown"]);

const SUPPORTED: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {
  chat: { models: ["replay"], defaultModel: "replay" },
  "design-workspace": { models: ["replay"], defaultModel: "replay" },
  summarise: { models: ["replay"], defaultModel: "replay" },
  "classify-image": { models: ["replay"], defaultModel: "replay" },
  "extract-text": { models: ["replay"], defaultModel: "replay" },
  "identify-image": { models: ["replay"], defaultModel: "replay" },
  "identify-glance": { models: ["replay"], defaultModel: "replay" },
  "split-image": { models: ["replay"], defaultModel: "replay" },
  "match-to-catalog": { models: ["replay"], defaultModel: "replay" },
};

function loadCassettes(dir: string): Cassette[] {
  const out: Cassette[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<Cassette>;
      if (typeof raw.match === "string" && Array.isArray(raw.rounds)) {
        const refuse = typeof raw.refuse === "string" && REASONS.has(raw.refuse) ? (raw.refuse as ProviderReason) : undefined;
        out.push({ match: raw.match, rounds: raw.rounds, ...(refuse ? { refuse } : {}), file: f });
      }
    } catch {
      console.warn(`[ai:replay] skipping unreadable cassette ${f}`);
    }
  }
  // Longest match first, so a specific cassette wins over a broad one and "*"
  // is always last.
  out.sort((a, b) => (a.match === "*" ? 1 : b.match === "*" ? -1 : b.match.length - a.match.length));
  return out;
}

/** An image cassette: the reply for one image, by its perceptual hash. */
interface ImageCassette {
  image_ahash: string;
  capability?: string;
  reply: string;
  file: string;
}

/** Bits of the 64-bit average hash that may differ and still match: a resize
 *  and a JPEG re-encode of the same picture move one or two. */
const HASH_TOLERANCE = 6;

function loadImageCassettes(dir: string): ImageCassette[] {
  const out: ImageCassette[] = [];
  const imagesDir = join(dir, "images");
  if (!existsSync(imagesDir)) return out;
  for (const f of readdirSync(imagesDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(imagesDir, f), "utf8")) as Partial<ImageCassette>;
      if (typeof raw.image_ahash === "string" && /^[0-9a-f]{16}$/i.test(raw.image_ahash) && typeof raw.reply === "string") {
        out.push({ image_ahash: raw.image_ahash.toLowerCase(), reply: raw.reply, file: f, ...(typeof raw.capability === "string" ? { capability: raw.capability } : {}) });
      }
    } catch {
      console.warn(`[ai:replay] skipping unreadable image cassette ${f}`);
    }
  }
  return out;
}

/** The 8x8 average hash of an image, 16 hex chars. The same function keys the
 *  cassettes (scripts/image-cassette-key.mjs), so the two cannot drift.
 *
 *  Hashed as DISPLAYED: a phone photo stores its raster sideways with an
 *  orientation tag, and the scan surfaces send it both ways (the identify
 *  sends the oriented medium variant, the split sends the original bytes).
 *  One picture keys one cassette. A file with no tag hashes as before. */
export async function imageAverageHash(bytes: Buffer): Promise<string> {
  const px = await sharp(bytes).rotate().grayscale().resize(8, 8, { fit: "fill" }).raw().toBuffer();
  const mean = px.reduce((a, b) => a + b, 0) / px.length;
  let bits = 0n;
  for (const v of px) bits = (bits << 1n) | (v >= mean ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}

function hammingHex(a: string, b: string): number {
  let d = 0n;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  while (x) {
    d += x & 1n;
    x >>= 1n;
  }
  return Number(d);
}

/** The image cassette for this call, or null: the nearest hash within
 *  tolerance, narrowed by capability when the cassette names one. */
async function imageCassetteFor(dir: string, capability: string, input: Record<string, unknown>): Promise<ImageCassette | null> {
  const b64 = typeof input.image_b64 === "string" ? input.image_b64 : typeof input.image === "string" ? input.image : null;
  if (!b64) return null;
  const all = loadImageCassettes(dir);
  if (!all.length) return null;
  let hash: string;
  try {
    hash = await imageAverageHash(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
  const near = all
    .map((c) => ({ c, d: hammingHex(hash, c.image_ahash) }))
    .filter(({ d }) => d <= HASH_TOLERANCE)
    .sort((a, b) => a.d - b.d)
    .map(({ c }) => c);
  return near.find((c) => c.capability === capability) ?? near.find((c) => !c.capability) ?? null;
}

function lastUserMessage(turns: ChatTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === "user") return turns[i]!.content;
  }
  return "";
}

/** Which round of a turn is this call? Count the assistant turns that carry
 *  tool_calls in the transcript: the loop appends one per completed round. */
/** The JSON of the most recent tool result in the transcript (of one tool,
 *  when named: "$result.list_records" reads past a bounce that came after
 *  the search), or null. */
function lastToolResult(turns: ChatTurn[], tool?: string): unknown {
  const nameOf = new Map<string, string>();
  for (const t of turns) if (t.role === "assistant") for (const c of t.tool_calls ?? []) nameOf.set(c.id, c.name);
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.role !== "tool") continue;
    if (tool && nameOf.get(t.tool_call_id ?? "") !== tool) continue;
    try {
      return JSON.parse(t.content);
    } catch {
      return null;
    }
  }
  return null;
}

/** "$prev.data.items[0].id" -> the value at that path in the previous tool
 *  result; "$result.list_records.data.items[0].id" -> in the most recent
 *  result of THAT tool. Any other value is returned as it is. Walks objects
 *  and arrays so a nested `args` is resolved too. */
function resolvePrevRefs(v: unknown, turns: ChatTurn[]): unknown {
  if (typeof v === "string") {
    const m = /^\$(prev|result\.([a-z_]+))\.(.+)$/.exec(v);
    if (!m) return v;
    let cur: unknown = lastToolResult(turns, m[2]);
    const path = m[3]!;
    for (const step of path.split(".")) {
      const idx = /^([^[]+)\[(\d+)\]$/.exec(step);
      const key = idx ? idx[1]! : step;
      cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
      if (idx) cur = Array.isArray(cur) ? cur[Number(idx[2])] : undefined;
    }
    return cur ?? v;
  }
  if (Array.isArray(v)) return v.map((x) => resolvePrevRefs(x, turns));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolvePrevRefs(x, turns)]));
  return v;
}

function roundIndex(turns: ChatTurn[]): number {
  return turns.filter((t) => t.role === "assistant" && (t.tool_calls?.length ?? 0) > 0).length;
}

let idCounter = 0;

export function register(): void {
  const dir = process.env.COBBLR_AI_REPLAY_DIR?.trim();
  if (!dir) return; // inert on every real instance
  // Belt and braces: this provider is credential-less, and a credential-less
  // provider is AUTO-SELECTED for any workspace with nothing else configured
  // (platform/ai.ts, the zero-config fallback). That is exactly what makes it
  // free to use in tests - and exactly why it must be impossible to switch on
  // where real users are. The env gate is the switch; refusing under a
  // production COBBLR_ENV is the guard for the day someone sets it by mistake.
  if (process.env.NODE_ENV === "production" && !process.env.COBBLR_AI_REPLAY_ALLOW_PROD) {
    console.error(
      "[ai:replay] COBBLR_AI_REPLAY_DIR is set under NODE_ENV=production; refusing to register a fake model. Set COBBLR_AI_REPLAY_ALLOW_PROD=1 only for a disposable instance.",
    );
    return;
  }
  if (!existsSync(dir)) {
    console.warn(`[ai:replay] COBBLR_AI_REPLAY_DIR=${dir} does not exist — provider not registered`);
    return;
  }
  console.log(`[ai:replay] provider registered with ${loadCassettes(dir).length} cassette(s) from ${dir}`);

  platform().ai.registerProvider({
    id: REPLAY_PROVIDER_ID,
    label: "Replay (recorded, for tests)",
    describeCredentials: () => ({}),
    // NOT auto-selected. Credential-less providers are picked up by any
    // workspace with nothing configured (the zero-config fallback), and the
    // first CI run with this on broke two tests that legitimately assert the
    // "no provider" path (the opt-out reasons, match-to-catalog's 502). A test
    // that wants a model installs this one on its workspace, explicitly, and
    // every other test keeps the world it was written for.
    autoSelectable: false,
    capabilities: SUPPORTED,
    // Same rule as every adapter: the cache key must include the prompt, or a
    // cassette edit would keep serving the cached reply.
    promptFingerprint,
    invoke: async (ctx) => {
      switch (ctx.capability) {
        case "chat": {
          const turns = turnsOf(ctx.input);
          const ask = lastUserMessage(turns).toLowerCase();
          // Read the directory EVERY call, not once at registration. Recording
          // and replaying are the same loop — you run a scenario against a real
          // model with COBBLR_AI_REPLAY_RECORD, then run it again replayed —
          // and a boot-time read makes the second step fail with "no cassette
          // matches" until someone restarts the api. That reads as a broken
          // cassette rather than a stale cache, and it cost a debugging session
          // (2026-08-19). A handful of small files per call is nothing next to
          // the model call this is standing in for.
          const cassettes = loadCassettes(dir);
          if (process.env.COBBLR_AI_REPLAY_DEBUG) console.log(`[ai:replay] ask: ${JSON.stringify(ask.slice(0, 200))}`);
          // The longest match wins: a cassette for "label on the cubepro #9"
          // is the answer to that sentence even though the shorter "label on
          // the cubepro" is a substring of it too (a re-ask with the record
          // named is the same sentence plus the name).
          const cassette =
            cassettes
              .filter((c) => c.match !== "*" && ask.includes(c.match.toLowerCase()))
              .sort((a, b) => b.match.length - a.match.length)[0] ??
            cassettes.find((c) => c.match === "*");
          if (process.env.COBBLR_AI_REPLAY_DEBUG) console.log(`[ai:replay] chose: ${cassette?.file ?? "(none)"} round ${roundIndex(turns)}`);
          if (!cassette) {
            // Say what IS there. "No cassette matches" with an empty directory
            // is a different problem from one with the wrong `match`.
            const have = cassettes.length
              ? cassettes.map((c) => `${c.file} (match: ${JSON.stringify(c.match)})`).join(", ")
              : "the directory holds none";
            throw new Error(
              `replay: no cassette matches "${ask.slice(0, 60)}" and no "*" fallback in ${dir} — ${have}`,
            );
          }
          if (cassette.refuse) {
            const status = cassette.refuse === "quota" ? 429 : cassette.refuse === "invalid_key" ? 401 : cassette.refuse === "model_unavailable" ? 404 : 503;
            const retry = cassette.refuse === "quota" ? 30 : undefined;
            throw new ProviderError("replay", cassette.refuse, providerSentence(cassette.refuse, { provider: "replay", retryAfterSec: retry }), status, retry);
          }
          const n = roundIndex(turns);
          const round = cassette.rounds[Math.min(n, cassette.rounds.length - 1)] ?? { content: "" };
          const tool_calls: ToolCall[] | undefined = round.tool_calls?.map((c) => ({
            id: `replay-${++idCounter}`,
            name: c.name,
            args: resolvePrevRefs(c.args ?? {}, turns) as Record<string, unknown>,
          }));
          return {
            result: {
              role: "assistant",
              content: round.content ?? "",
              ...(tool_calls?.length ? { tool_calls } : {}),
            },
            input_tokens: 0,
            output_tokens: 0,
            cost_cents: 0,
          };
        }
        case "summarise":
          return { result: { text: String(ctx.input.text ?? "").slice(0, 120) }, cost_cents: 0 };
        default: {
          // Image capabilities: a cassette keyed by the image's bytes when the
          // test scripted one, else a stable, obviously-fake answer so a scan
          // test can still run end to end without a vision model.
          const scripted = await imageCassetteFor(dir, ctx.capability, (ctx.input ?? {}) as Record<string, unknown>);
          if (scripted) return { result: { text: scripted.reply }, input_tokens: 0, output_tokens: 0, cost_cents: 0 };
          return { result: { text: '{"name":"replayed item","confidence":0.5}' }, cost_cents: 0 };
        }
      }
    },
    // The probe's cassette: what a save's key check answers, by the key's
    // own prefix, so a route test can save a bad key, a spent quota and a
    // dead provider without a network or a token. Anything else is a good key.
    //   invalid-…  -> invalid_key      quota-… -> quota
    //   down-…     -> unreachable      nomodel-… -> model_unavailable
    testConnection: async (credentials) => {
      const key = String(credentials.api_key ?? "");
      const reason: ProviderReason | null = key.startsWith("invalid-")
        ? "invalid_key"
        : key.startsWith("quota-")
          ? "quota"
          : key.startsWith("down-")
            ? "unreachable"
            : key.startsWith("nomodel-")
              ? "model_unavailable"
              : null;
      if (!reason) return { ok: true, models: ["replay-model"] };
      return { ok: false, reason, error: providerSentence(reason, { provider: "replay", retryAfterSec: reason === "quota" ? 30 : undefined }) };
    },
  });
}

/** Recording, for building cassettes from a real model. Wrap a real provider's
 *  chat result: append this turn's round to <dir>/<slug>.json. Called by the
 *  chat route when COBBLR_AI_REPLAY_RECORD is set. */
export function recordRound(
  turns: ChatTurn[],
  result: { content?: string; tool_calls?: ToolCall[] },
  providerId?: string,
): void {
  const dir = process.env.COBBLR_AI_REPLAY_RECORD?.trim();
  if (!dir) return;
  // Never record a REPLAY. Recording into the directory being replayed is the
  // documented workflow (run it live once, then iterate for free) — and it ate
  // itself: the replayed answer was written back as a NEW cassette whose
  // `match` was longer than the hand-written one, so the next run replayed
  // stale ids and the whole scenario failed on data that no longer existed
  // (2026-08-19). A fixture set that grows every time you use it is not a
  // fixture set.
  if (providerId === REPLAY_PROVIDER_ID) return;
  try {
    mkdirSync(dir, { recursive: true });
    const ask = lastUserMessage(turns);
    const slug = ask.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "turn";
    const file = join(dir, `${slug}.json`);
    const existing: Cassette = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Cassette)
      : { match: ask.slice(0, 40), rounds: [], file };
    existing.rounds.push({
      ...(result.content ? { content: result.content } : {}),
      ...(result.tool_calls?.length
        ? { tool_calls: result.tool_calls.map((c) => ({ name: c.name, args: c.args })) }
        : {}),
    });
    writeFileSync(file, JSON.stringify({ match: existing.match, rounds: existing.rounds }, null, 2));
  } catch (e) {
    console.warn(`[ai:replay] could not record: ${(e as Error).message}`);
  }
}
