// The kind an activity entry's record is FILED under. The route resolves it
// from the live record (`bookshelf:item`) so the feed can use the
// collection's noun; a deleted record falls back to the module kind, whose
// type suffix is the module's own word for the thing.
export function activityKind(e: {
  entity_kind?: string | null;
  module_name: string | null;
  entity_type: string;
}): string {
  return e.entity_kind ?? (e.module_name ? `${e.module_name}:${e.entity_type}` : e.entity_type);
}
