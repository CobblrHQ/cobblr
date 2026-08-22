// What a confirm card says an action will do.
//
// It said "Run inventory:add-category" — the internal id of the action, and
// nothing about the category being added or what it would be called. A person
// is being asked to approve a change; naming the mechanism instead of the
// change asks them to trust a string they have never seen. The same fault as
// printing a uuid, one level up: the reader is shown plumbing.
//
// Every action already carries a human label ("Add a category") and declares
// its arguments, so the words exist; nothing needed inventing, only using.

export interface ActionCopy {
  /** The action's own label, e.g. "Add a category". */
  label?: string | null;
  /** argsSchema: name → { label }. */
  args_schema?: Record<string, { label?: string; type?: string }> | null;
}

/** The one value worth putting in the summary: what the thing will be called.
 *  A category's `name`, a group's `label` — the argument a person would use to
 *  recognise their own request. */
function subjectOf(args: Record<string, unknown>): string | null {
  for (const key of ["name", "title", "label", "query"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * "Add a category: Kitchen & Grocery" — not "Run inventory:add-category".
 *
 * Falls back through what it has: the action's label, then its id, because a
 * card with no words at all is worse than a card naming the mechanism. `on`
 * is the record a record-scoped action runs against.
 */
export function summariseAction(
  actionId: string,
  copy: ActionCopy | null,
  args: Record<string, unknown> = {},
  on?: string | null,
): string {
  const verb = copy?.label?.trim() || `Run ${actionId}`;
  const subject = subjectOf(args);
  const target = on?.trim();
  if (target) return subject ? `${verb} on “${target}”: ${subject}` : `${verb} on “${target}”`;
  return subject ? `${verb}: ${subject}` : verb;
}
