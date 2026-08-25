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
import { scrubIds, namesFromToolResults } from "./scrub-ids.js";
import { stripStageDirections } from "./stage-directions.js";

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
  /** Progress, as it happens. Optional so every existing caller and test is
   *  unchanged; the chat route passes one to feed the persisted turn log, which
   *  is what lets a widget show "reading your locations…" instead of nothing
   *  for the whole turn. Never awaited on the hot path for the model. */
  onEvent?(ev: AgentLoopEvent): void | Promise<void>;
}

export type AgentLoopEvent =
  | { kind: "thinking"; round: number }
  | { kind: "tool"; name: string; args: Record<string, unknown>; write: boolean }
  | { kind: "tool-result"; name: string; ok: boolean; summary: string }
  | { kind: "applied"; name: string; summary: string }
  | { kind: "text-delta"; text: string };

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

  const emit = (ev: AgentLoopEvent): void => {
    if (!deps.onEvent) return;
    // Fire-and-forget: a slow event sink must never slow the turn, and a
    // failing one must never fail it. Both a synchronous throw and a rejected
    // promise are swallowed - `Promise.resolve(fn())` alone lets a sync throw
    // escape, because it happens before there is a promise to catch it on.
    try {
      void Promise.resolve(deps.onEvent(ev)).catch(() => {});
    } catch {
      /* a broken sink is the sink's problem */
    }
  };

  let nudgedForSilence = false;
  // Every id the tools handed back, with what it is called. The answer is
  // scrubbed of ids before it reaches a person (scrub-ids.ts); knowing the
  // names is what lets "(67377d87-…)" become "(Den)" instead of vanishing.
  const seenNames = new Map<string, string>();
  for (let round = 0; round < maxRounds; round++) {
    emit({ kind: "thinking", round });
    const r = await deps.callModel(transcript);
    const calls = r.tool_calls ?? [];

    if (calls.length === 0) {
      if (r.content.trim()) return { kind: "reply", text: stripStageDirections(scrubIds(r.content, seenNames)), applied };
      // No tool calls AND no words. Two different models arrive here for two
      // opposite reasons, and the nudge has to serve both:
      //
      //   a broken CALL — the model tried to call a tool, malformed it, and the
      //   provider stripped it (gemini-3.1-flash-lite returns finish_reason
      //   "MALFORMED_FUNCTION_CALL" this way on 3 of 9 runs);
      //
      //   a silent THINK — a local reasoning model spends its turn reasoning and
      //   emits an empty final message with done_reason "stop" (qwen3:14b, on a
      //   request to run an action, measured 2026-08-25: 900 chars of thinking,
      //   zero content, no call).
      //
      // Either way the user sees a blank bubble. The nudge used to say "Do not
      // call a tool this time", which is right for the first and exactly wrong
      // for the second: it tells a model that went quiet mid-action to describe
      // the action instead of doing it. So it asks for either, and names both.
      if (!nudgedForSilence) {
        nudgedForSilence = true;
        transcript.push({
          role: "user",
          content:
            "(Your last message arrived empty — the user saw nothing. If you were part-way through " +
            "running something, call the tool now. Otherwise answer in plain words.)",
        });
        continue;
      }
      return {
        kind: "reply",
        text: "Sorry, I couldn't get that answer out. Try asking me again, or in a different way.",
        applied,
      };
    }

    const pendingProposals: ToolCall[] = [];
    const turnResults: Array<{ call: ToolCall; text: string }> = [];

    for (const call of calls) {
      if (!deps.isWrite(call.name)) {
        // Read — always executes.
        emit({ kind: "tool", name: call.name, args: call.args, write: false });
        let resultText: string;
        let ok = true;
        try {
          resultText = clampJson(await deps.executeRead(call.name, call.args), maxChars);
        } catch (err) {
          ok = false;
          resultText = clampJson({ ok: false, error: (err as Error)?.message ?? "tool failed" }, maxChars);
        }
        emit({ kind: "tool-result", name: call.name, ok, summary: resultText.slice(0, 160) });
        turnResults.push({ call, text: resultText });
        try {
          for (const [id, label] of namesFromToolResults([JSON.parse(resultText)])) seenNames.set(id, label);
        } catch {
          /* a clamped/truncated result is not parseable — no names, no harm */
        }
        continue;
      }
      // Write — auto-apply when allowed, else queue as a proposal.
      if (deps.executeWrite) {
        emit({ kind: "tool", name: call.name, args: call.args, write: true });
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
          emit({ kind: "applied", name: call.name, summary: clampJson(result, 160) });
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
      "(You've used the maximum number of tool rounds. Answer the user now with what you've learned: no more tool calls.)",
  });
  const last = await deps.callModel(transcript);
  return { kind: "reply", text: last.content, applied };
}
