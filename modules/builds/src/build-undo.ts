// The way back from recording a build of N: one step, as the action layer
// hands it back. The build action and the Build button's route both answer
// with this, so a build pressed from the sheet can be taken back exactly as
// one made by the assistant is.

export interface BuildUndoStep {
  action_id: "builds:reverse-one";
  args: { build_id: string; qty: number };
  entity_kind: "builds:build";
  entity_id: string;
}

export function buildUndoStep(buildId: string, qty: number, entityId: string = buildId): BuildUndoStep {
  return { action_id: "builds:reverse-one", args: { build_id: buildId, qty }, entity_kind: "builds:build", entity_id: entityId };
}
