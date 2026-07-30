// Which capabilities a WORKSPACE may grant, out of everything the SERVER knows.
//
// `cobblr_meta.entity_actions` registers what every module loaded by the process
// declares. It is not per-workspace, so reading it directly offers an admin
// capabilities their workspace cannot exercise: a workspace that never enabled
// BrickLink was still shown `bricklink:disassemble-kit` when creating a role —
// a permission to do something impossible here, named after a product its owner
// may never have heard of.
//
// Split out from the route so the rule can be tested without a database.

/** Decide which capabilities survive for one workspace.
 *
 *  Conservative in one direction on purpose. A capability is dropped only when
 *  its module is one we can SEE in the registry and this workspace lacks it.
 *  Anything unattributable — a platform endpoint gate, a field-scope capability,
 *  an id whose prefix names no loaded module — is KEPT.
 *
 *  The asymmetry is deliberate: showing one capability too many is a wart an
 *  admin can ignore, while hiding one they need locks them out of their own
 *  permissions screen with nothing on it to explain why. When the rule is
 *  unsure, it shows.
 */
export function scopeToWorkspace<T extends { module: string }>(
  items: readonly T[],
  opts: { enabled: ReadonlySet<string>; known: ReadonlySet<string> },
): T[] {
  return items.filter((a) => !opts.known.has(a.module) || opts.enabled.has(a.module));
}

/** The owning module of a capability. Explicit registration wins; otherwise the
 *  id's prefix names it (`bricklink:disassemble-kit`), and a bare id with no
 *  prefix is platform-level. */
export function capabilityModule(actionId: string, moduleName?: string | null): string {
  return moduleName || actionId.split(":")[0] || "platform";
}
