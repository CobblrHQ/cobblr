// One signal for a record made or changed, whichever door it came through
// (#3818).
//
// Every module emits its own event for its own records ("records.record.added",
// "inventory.part.created"), so a capability that must react to ANY record had
// to know every module's names and would miss the next module written. The
// kernel sees every create and update on its way out of a module's routes
// (and an instance's), knows the kind from the registry, and says it once
// here. A capability subscribes to this, never to a module's own names.
// Buildless subpath: no runtime import of a sibling.

export const ENTITY_SAVED_EVENT = "platform.entity.saved";

export interface EntitySavedEvent {
  orgId: string;
  /** The kind as the registry names it: "machines:machine", "yarn:item". */
  kind: string;
  id: string;
  /** The record's title, by the kind's title field, when it has one. */
  title: string | null;
  /** Whether the record carries a picture now, by the kind's image field.
   *  Null for a kind that declares no image field. */
  hasImage: boolean | null;
  /** Made by this request (a create), or changed by it (an update). */
  created: boolean;
  /** Who made the change, when a person did. */
  userId: string | null;
}
