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
// Recording new cassettes: `COBBLR_AI_REPLAY_RECORD=<dir>` on an instance with a
// real provider writes one file per turn with the rounds the model actually
// produced. Copy the ones you want into the replay dir and edit the "match".

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { platform, type AiCapability } from "@cobblr/platform-contract";
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
  file: string;
}

const SUPPORTED: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {
  chat: { models: ["replay"], defaultModel: "replay" },
  summarise: { models: ["replay"], defaultModel: "replay" },
  "classify-image": { models: ["replay"], defaultModel: "replay" },
  "extract-text": { models: ["replay"], defaultModel: "replay" },
  "identify-image": { models: ["replay"], defaultModel: "replay" },
  "match-to-catalog": { models: ["replay"], defaultModel: "replay" },
};

function loadCassettes(dir: string): Cassette[] {
  const out: Cassette[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<Cassette>;
      if (typeof raw.match === "string" && Array.isArray(raw.rounds)) {
        out.push({ match: raw.match, rounds: raw.rounds, file: f });
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

function lastUserMessage(turns: ChatTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === "user") return turns[i]!.content;
  }
  return "";
}

/** Which round of a turn is this call? Count the assistant turns that carry
 *  tool_calls in the transcript: the loop appends one per completed round. */
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
  const cassettes = loadCassettes(dir);
  console.log(`[ai:replay] provider registered with ${cassettes.length} cassette(s) from ${dir}`);

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
          const cassette =
            cassettes.find((c) => c.match !== "*" && ask.includes(c.match.toLowerCase())) ??
            cassettes.find((c) => c.match === "*");
          if (!cassette) {
            throw new Error(
              `replay: no cassette matches "${ask.slice(0, 60)}" and no "*" fallback in ${dir}`,
            );
          }
          const n = roundIndex(turns);
          const round = cassette.rounds[Math.min(n, cassette.rounds.length - 1)] ?? { content: "" };
          const tool_calls: ToolCall[] | undefined = round.tool_calls?.map((c) => ({
            id: `replay-${++idCounter}`,
            name: c.name,
            args: c.args ?? {},
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
        default:
          // Image capabilities: a stable, obviously-fake answer so a scan test
          // can run end to end without a vision model.
          return { result: { text: '{"name":"replayed item","confidence":0.5}' }, cost_cents: 0 };
      }
    },
    testConnection: async () => ({ ok: true }),
  });
}

/** Recording, for building cassettes from a real model. Wrap a real provider's
 *  chat result: append this turn's round to <dir>/<slug>.json. Called by the
 *  chat route when COBBLR_AI_REPLAY_RECORD is set. */
export function recordRound(turns: ChatTurn[], result: { content?: string; tool_calls?: ToolCall[] }): void {
  const dir = process.env.COBBLR_AI_REPLAY_RECORD?.trim();
  if (!dir) return;
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
