// The workspace's own conversation: the one that is not about anything.
//
// Discussion was built as a polymorphic side-car — a conversation belongs to a
// record, the same shape tags and files use. That is right for "is this the
// M3 or the M4", and it quietly ruled out the most ordinary thing a team does,
// which is talk. Google Docs has the same two halves: you can comment on a
// selection, and you can also just say something to the room.
//
// A room needs no new table. The conversation key is a source triple, and the
// workspace already has a uuid of its own, so the room is that triple pointed
// at the workspace itself. One row, one unique constraint, no migration.
//
// The `@` prefix marks it as PLATFORM state rather than a module's: it can
// never collide with a real module name, because a module may not be called
// "@workspace". Same device the kernel already uses for the scan category
// placeholder (`@scan-category`).
//
// Defined here, in the contract, because the api and the web app both have to
// agree on the exact triple. A room the two halves spelled differently would be
// two rooms, and each would look empty from the other side.

/** The `source_module` of a workspace-wide conversation. */
export const WORKSPACE_ROOM_MODULE = "@workspace";
/** Its `source_type`. */
export const WORKSPACE_ROOM_TYPE = "workspace";

/** The full source triple for a workspace's room. `orgId` is the workspace's
 *  own id, which is what makes one room per workspace fall out of the existing
 *  unique (module, type, id) constraint. */
export function workspaceRoomSource(orgId: string): {
  source_module: string;
  source_type: string;
  source_id: string;
} {
  return {
    source_module: WORKSPACE_ROOM_MODULE,
    source_type: WORKSPACE_ROOM_TYPE,
    source_id: orgId,
  };
}

/** Is this conversation the room rather than a record's thread?
 *
 *  Every surface that resolves a conversation's subject has to ask: the room
 *  has no entity to look up, and asking the entity registry for one returns
 *  nothing, which renders as "(deleted)" — a room that says it was deleted is
 *  worse than no room. */
export function isWorkspaceRoom(src: { source_module: string; source_type: string }): boolean {
  return src.source_module === WORKSPACE_ROOM_MODULE && src.source_type === WORKSPACE_ROOM_TYPE;
}
