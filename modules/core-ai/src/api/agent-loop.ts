// The chat agent loop — PURE. The model is injected as `callModel`, tool
// execution as `executeRead` / optional `executeWrite`, so the loop's real
// behavior is unit-tested without a provider.
//
// One user turn runs ONE loop:
//   call the model with tools →
//     no tool_calls → final reply (the legacy JSON-move parse happens upstream)
//     read calls    → execute NOW (caller's permissions), append results, loop
//     write calls   → two modes:
//       ASK  (no executeWrite): STOP; hand the write calls back as proposals
//            for the user-confirm gate. Writes NEVER run inside the loop.
//       AUTO (executeWrite provided): each write is offered to executeWrite —
//            applied (ledgered + undoable upstream) → its result feeds back and
//            the loop CONTINUES (true multi-step); returns null → that call
//            still must propose (e.g. actions — irreversible side effects — or
//            the per-turn write cap), and the loop stops with the remainder.
//
// Applied writes are reported on the outcome either way, so the UI can render
// "✓ done — Undo" cards. Read results are clamped so a big list can't blow the
// prompt; the round cap keeps a confused model from ping-ponging forever.

import type { ToolCall, ChatTurn } from "../providers/tool-wire.js";

export interface LoopModelResult {
  content: string;
  tool_calls?: ToolCall[];
}

export interface AppliedWrite {
  call: ToolCall;
  /** What executeWrite returned (the ledger row summary — id, label, undo). */
  result: unknown;
}

export interface AgentLoopDeps {
  /** One model call over the CURRENT transcript (system+tools ride outside). */
  callModel(turns: ChatTurn[]): Promise<LoopModelResult>;
  /** Execute one READ tool; returns a JSON-stringifiable result. */
  executeRead(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Is this tool a write (proposal/auto-apply) rather than an auto-run read? */
  isWrite(name: string): boolean;
  /** AUTO mode only: apply one write NOW (ledgered upstream) and return its
   *  result, or null when this call must still be proposed (actions, caps). */
  executeWrite?(call: ToolCall): Promise<unknown | null>;
  maxRounds?: number;
  /** Per-result clamp, chars of JSON. */
  maxResultChars?: number;
}

export type AgentLoopOutcome =
  | { kind: "reply"; text: string; applied: AppliedWrite[] }
  | { kind: "writes"; calls: ToolCall[]; text: string; applied: AppliedWrite[] };

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_MAX_RESULT_CHARS = 4000;

export function clampJson(value: unknown, maxChars: number): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? "null";
  } catch {
    s = String(value);
  }
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}…[truncated ${s.length - maxChars} chars]`;
}

export async function runAgentLoop(turns: ChatTurn[], deps: AgentLoopDeps): Promise<AgentLoopOutcome> {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxChars = deps.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const transcript: ChatTurn[] = [...turns];
  const applied: AppliedWrite[] = [];

  for (let round = 0; round < maxRounds; round++) {
    const r = await deps.callModel(transcript);
    const calls = r.tool_calls ?? [];

    if (calls.length === 0) return { kind: "reply", text: r.content, applied };

    const pendingProposals: ToolCall[] = [];
    const turnResults: Array<{ call: ToolCall; text: string }> = [];

    for (const call of calls) {
      if (!deps.isWrite(call.name)) {
        // Read — always executes.
        let resultText: string;
        try {
          resultText = clampJson(await deps.executeRead(call.name, call.args), maxChars);
        } catch (err) {
          resultText = clampJson({ ok: false, error: (err as Error)?.message ?? "tool failed" }, maxChars);
        }
        turnResults.push({ call, text: resultText });
        continue;
      }
      // Write — auto-apply when allowed, else queue as a proposal.
      if (deps.executeWrite) {
        let result: unknown | null = null;
        try {
          result = await deps.executeWrite(call);
        } catch (err) {
          // A failed auto-write feeds the error back like a read failure — the
          // model can react (retry differently / tell the user) — never a
          // half-recorded proposal.
          turnResults.push({
            call,
            text: clampJson({ ok: false, error: (err as Error)?.message ?? "write failed" }, maxChars),
          });
          continue;
        }
        if (result !== null) {
          applied.push({ call, result });
          turnResults.push({ call, text: clampJson(result, maxChars) });
          continue;
        }
      }
      pendingProposals.push(call);
    }

    if (pendingProposals.length > 0) {
      // Some write(s) still need the confirm gate — stop here. Anything already
      // applied this turn is reported alongside.
      return { kind: "writes", calls: pendingProposals, text: r.content, applied };
    }

    // Everything executed — feed the results back and continue the loop.
    transcript.push({ role: "assistant", content: r.content, tool_calls: calls });
    for (const tr of turnResults) {
      transcript.push({ role: "tool", content: tr.text, tool_call_id: tr.call.id });
    }
  }

  // Round cap: the model kept going without concluding. Ask it to answer
  // with what it has — one final call with tools implicitly exhausted.
  transcript.push({
    role: "user",
    content:
      "(You've used the maximum number of tool rounds. Answer the user now with what you've learned — no more tool calls.)",
  });
  const last = await deps.callModel(transcript);
  return { kind: "reply", text: last.content, applied };
}
