import type { CommandRun, CommandRunResult, PendingCommandRun } from "./api/ai";
import { unknownCommandOutcome } from "./api/ai";
import { personalChatKey } from "./personal-chat-store";
import type { StoredChatMessage } from "./chat-store";

interface RecoveredSection {
  commandRunId?: string;
  pending?: boolean;
  commandRequest?: CommandRunResult["pendingRequest"];
  ok: boolean;
  message: string;
  ledgerIds: string[];
  undoable: boolean;
}
export interface CommandMessage extends StoredChatMessage {
  commandRunId?: string;
  commandPending?: boolean;
  commandRequest?: CommandRunResult["pendingRequest"];
  command?: { id: string; message: string };
  sections?: Record<string, RecoveredSection>;
  ledgerIds?: string[];
  undoable?: boolean;
  ranCommand?: { id: string; message: string };
  destination?: { kind: string; label: string };
}

export function recoveredCommandResult(run: CommandRun): CommandRunResult {
  if (run.status !== "done" || !run.result) return unknownCommandOutcome(run.id);
  if (run.result.error) return { run_id: run.id, ok: false, done: 0, failed: 1, message: run.result.error.message };
  return run.result;
}

/** Merge by run identity, never by the command's words: a person may ask the same thing twice. */
export function recoverCommandMessages<M extends CommandMessage>(messages: M[], runs: CommandRun[]): M[] {
  let next = messages;
  for (const run of runs) {
    const out = recoveredCommandResult(run);
    const index = next.findIndex((m) => m.commandRunId === run.id);
    const sectionIndex = next.findIndex((m) => Object.values(m.sections ?? {}).some((s) => s.commandRunId === run.id));
    if (index >= 0 && !next[index]!.commandPending || sectionIndex >= 0 && !Object.values(next[sectionIndex]!.sections ?? {}).some((s) => s.commandRunId === run.id && s.pending)) continue;
    let offerIndex = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      const m = next[i]!;
      if (m.command?.id === run.command_id && m.command.message === run.request.message && !m.resolved) { offerIndex = i; break; }
    }
    const cardIndex = sectionIndex >= 0 ? sectionIndex : offerIndex;
    const sectionId = run.request.section ? next[cardIndex]?.sections?.[run.request.section]?.commandRunId : undefined;
    if (run.request.section && cardIndex >= 0 && (!sectionId || sectionId === run.id)) {
      const at = next[cardIndex]!;
      const section = { commandRunId: run.id, pending: !!out.pending, commandRequest: out.pending ? { command_id: run.command_id, request: run.request, durable: true as const } : undefined, ok: out.ok, message: out.message, ledgerIds: out.ledger_ids ?? [], undoable: !!out.ledger_ids?.length && out.undoable !== false };
      next = next.map((m, i) => i === cardIndex ? { ...at, sections: { ...at.sections, [run.request.section!]: section } } : m);
      continue;
    }
    const result = {
      role: "assistant" as const, commandRunId: run.id, commandPending: !!out.pending,
      ...(out.pending ? { commandRequest: { command_id: run.command_id, request: run.request, durable: true as const } } : {}),
      content: (out.pending ? "" : out.ok ? "✓ " : "✗ ") + out.message,
      resolved: !out.pending, ledgerIds: out.ledger_ids ?? [], undoable: out.undoable !== false && !!out.ledger_ids?.length,
      ...(out.ok ? { ranCommand: { id: run.command_id, message: run.request.message } } : {}),
      ...(out.destination ? { destination: out.destination } : {}),
      ...(out.touched?.length ? { refs: out.touched } : {}),
    } as M;
    if (index >= 0) next = next.map((m, i) => i === index ? result : m);
    else {
      if (offerIndex >= 0 && !run.request.section) next = next.map((m, i) => i === offerIndex ? { ...m, resolved: true } : m);
      const lastUser = [...next].reverse().find((m) => m.role === "user");
      if (lastUser?.content !== run.request.message) next = [...next, { role: "user", content: run.request.message } as M];
      next = [...next, result];
    }
  }
  return next;
}

/** A request that never reached the server can be sent again only with the same run ID. */
export function commandRequestsToRecover(messages: CommandMessage[], runs: CommandRun[]): PendingCommandRun[] {
  const known = new Set(runs.map((run) => run.id));
  const missing: PendingCommandRun[] = [];
  const take = (id: string | undefined, pending: boolean | undefined, request: CommandRunResult["pendingRequest"]) => {
    if (!id || !pending || !request || known.has(id)) return;
    known.add(id);
    missing.push({ id, command_id: request.command_id, request: request.request, replayable: request.durable === true, status: "running", result: null });
  };
  for (const message of messages) {
    take(message.commandRunId, message.commandPending, message.commandRequest);
    for (const section of Object.values(message.sections ?? {})) take(section.commandRunId, section.pending, section.commandRequest);
  }
  return missing;
}

/** Replay reads the owner's saved copy, never a previous account's render during a scope change. */
export function personalCommandRequestsToRecover(owner: string, slug: string, runs: CommandRun[]): PendingCommandRun[] {
  const key = personalChatKey("chat", owner, slug);
  if (!key) return [];
  try {
    const messages: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(messages) ? commandRequestsToRecover(messages, runs) : [];
  } catch {
    return [];
  }
}
