// The capability a person needs to CREATE a record, where a module gates its
// create endpoint on one (`requireCapability`) rather than on role alone.
//
// Written down once. The portal's view page, the App Player and the scan
// inbox each carried their own `{ "inventory:part": "inventory:create-part" }`
// to decide whether to offer a create button, and the scan inbox had none at
// all — so a member saw Add on every row and learned they could not file only
// from the 403 (#3072, #3073). A surface that wants to know whether a person
// may file into a table asks here, with the same answer the server's gate
// gives.
//
// Every other module's create is role-gated (member or better), which the
// rank model answers (`roleSatisfies(role, ["member"])`); those need no entry.

interface CreateGate {
  /** The base kind the module creates. */
  kind: string;
  /** The capability its create endpoint checks. */
  capability: string;
}

const BY_MODULE: Record<string, CreateGate> = {
  inventory: { kind: "inventory:part", capability: "inventory:create-part" },
};

/** The capability behind creating this base kind, or null when its module
 *  gates creation on role alone. */
export function createCapabilityForKind(kind: string | null | undefined): string | null {
  if (!kind) return null;
  for (const gate of Object.values(BY_MODULE)) if (gate.kind === kind) return gate.capability;
  return null;
}

/** The capability behind creating records in this module (an instance of
 *  it included), or null when its create is role-gated. */
export function createCapabilityForModule(module: string | null | undefined): string | null {
  return module ? (BY_MODULE[module]?.capability ?? null) : null;
}

/** May this person create in this module, given what /me/capabilities said?
 *  The admin tier always (`all`); otherwise the module's gate must be among
 *  the grants, or the module must have no gate beyond role. */
export function mayCreateIn(
  module: string | null | undefined,
  caps: { all: boolean; grants: readonly string[] } | null | undefined,
): boolean | null {
  if (!caps) return null;
  if (caps.all) return true;
  const gate = createCapabilityForModule(module);
  return gate ? caps.grants.includes(gate) : true;
}
