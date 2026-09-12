// How an action says it is undone.
//
// An action that can be put back registers, beside its handler, a function
// from its RESULT to the steps that put it back. A step is either another
// action (with the record it runs on, when it runs on one) or a plain record
// write (a delete for a row the action created, an update for fields it
// changed), in the same terms the write rail already runs and ledgers. The
// steps are stored beside the ledger row when the action runs, so Undo on
// the card runs them; each step is ledgered as a write of its own, whose own
// inverse is the original again, so undoing an undo needs nothing extra.
//
// Where an inverse needs the prior state, the action's result carries it
// (the way the kernel's move carries the ids it moved). An action that hands
// back null, or an empty list, left nothing to put back this run: a feature
// that was already on, a tag that was already there.

export type ActionUndoStep =
  | {
      action_id: string;
      args: Record<string, unknown>;
      /** The record the inverse runs on, for an entity-scoped action. */
      entity_kind?: string;
      entity_id?: string;
    }
  | {
      tool: "delete" | "update";
      entity_kind: string;
      entity_id: string;
      fields?: Record<string, unknown>;
    };

export interface ActionUndoContext {
  orgId: string;
  /** The record the action ran on, for an entity-scoped one. */
  entity?: { kind: string; id: string };
}

export type ActionUndoer = (
  result: unknown,
  ctx: ActionUndoContext,
) => Promise<ActionUndoStep | ActionUndoStep[] | null> | ActionUndoStep | ActionUndoStep[] | null;

/** Whether a step is an action step (as opposed to a record write). */
export function isActionStep(step: ActionUndoStep): step is Extract<ActionUndoStep, { action_id: string }> {
  return typeof (step as { action_id?: unknown }).action_id === "string";
}
