import type { EntityWriter } from "@cobblr/platform-contract";

/** A failed delete is complete only when the owning writer confirms absence.
 *  Read first so cleanup resumed after a later failure does not delete twice. */
export async function deleteMirror(writer: EntityWriter, orgId: string, id: string): Promise<void> {
  if (writer.read && await writer.read(orgId, id) === null) return;
  try {
    await writer.delete(orgId, id);
  } catch (err) {
    if (!writer.read || await writer.read(orgId, id) !== null) throw err;
  }
}
