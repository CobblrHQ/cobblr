// What "that" means, with no model in the room.
//
// Basic mode's control rules — yes, again, undo, stop — used to be honest dead
// ends: "there is nothing waiting for a yes", true only because nobody told
// the matcher what had just happened. The conversation knows. The client keeps
// it, so the client sends a bounded summary of the prior turn and this module
// resolves the reference — statelessly, the same way every other basics call
// works.
//
// The consent rule holds: nothing here RUNS anything. The resolver names the
// act, the client executes it through the same endpoints the buttons use
// (/commands/:id/run re-matches and re-validates server-side; /writes/:id/undo
// checks ownership per id). A typed "go for it" is the person saying yes — the
// same yes the Do-it button says, in words.

export interface BasicPrior {
  /** The last command OFFERED in this conversation and the message that
   *  triggered it — what "yes" and "go for it" point at. */
  offered?: { id: string; message: string };
  /** The last command that RAN — what "again" points at. */
  ran?: { id: string; message: string };
  /** Ledger rows of the last change made from this conversation — what
   *  "undo" points at. */
  ledger_ids?: string[];
}

export type BasicAct =
  | { kind: "run-command"; id: string; message: string }
  | { kind: "undo"; ledger_ids: string[] }
  | { kind: "dismiss-offer" };

/** The control-rule keys this resolver serves. Every other rule ignores prior. */
export const CONTROL_KEYS = new Set(["confirm-yes", "retry", "undo", "stop-cancel"]);

/**
 * Resolve a control intent against the prior turn. Null means the prior gives
 * the words nothing to point at, and the rule's ordinary reply (the honest
 * decline) stands.
 */
export function resolveControlAct(ruleKey: string, prior: BasicPrior | undefined): BasicAct | null {
  if (!prior) return null;
  switch (ruleKey) {
    case "confirm-yes":
      // "yes" confirms the standing offer. It does NOT re-run a command that
      // already ran: "yes" after a result is agreement, not an instruction.
      return prior.offered ? { kind: "run-command", ...prior.offered } : null;
    case "retry":
      // "again" prefers the thing that actually happened; failing that, an
      // offer never taken is the only thing "again" could mean.
      return prior.ran
        ? { kind: "run-command", ...prior.ran }
        : prior.offered
          ? { kind: "run-command", ...prior.offered }
          : null;
    case "undo":
      return prior.ledger_ids?.length ? { kind: "undo", ledger_ids: prior.ledger_ids } : null;
    case "stop-cancel":
      // Nothing runs in basic mode, so "stop" can only wave off a standing
      // offer. With none, the ordinary reply already says nothing is running.
      return prior.offered ? { kind: "dismiss-offer" } : null;
    default:
      return null;
  }
}

/** What the acting reply SAYS — one line, since the result message follows. */
export function actReply(act: BasicAct, template?: string): string {
  switch (act.kind) {
    case "run-command":
      return template ? `On it: **${template}**.` : "On it.";
    case "undo":
      return act.ledger_ids.length === 1 ? "Taking that back." : `Taking those ${act.ledger_ids.length} changes back.`;
    case "dismiss-offer":
      return "Okay, leaving it alone.";
  }
}
