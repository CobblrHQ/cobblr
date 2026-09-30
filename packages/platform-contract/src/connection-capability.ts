// The two capability id spaces a connection can be ranked in, and the one
// rule that keeps them apart.
//
// AI capabilities (`identify-image`, `chat`) and service capabilities
// (`slice.model`, `design.part`) share `user_credential_orgs.capability`, so
// "who does what, in order" is one table for both. They must never collide: a
// service capability always contains a dot and an AI capability never does.
// The column's CHECK (platform migration 156) holds the shape of both, the
// manifest validator refuses an undotted service capability, and ranking
// refuses an id on the wrong kind of connection through this.
//
// Buildless subpath: no runtime import of a sibling.

/** The connection kind of an external service (docs/design-decisions/services.md). */
export const SERVICE_KIND = "service";

/** A service capability id: always dotted (`slice.model`). */
export function isServiceCapability(capability: string): boolean {
  return capability.includes(".");
}

/** Whether a connection of `kind` may be ranked for `capability`: a dotted id
 *  only on a service, an undotted one never on a service. */
export function capabilityFitsKind(capability: string, kind: string): boolean {
  return isServiceCapability(capability) === (kind === SERVICE_KIND);
}

/** The shape of a capability id in either space, the same as the column's
 *  CHECK: lower-case words joined by `-` (AI), or such words joined by `.`
 *  (a service). */
const AI_ID = /^[a-z][a-z0-9-]*$/;
/** The manifest validator's own shape (SERVICE_CAPABILITY_ID in ./services),
 *  so ranking never refuses an id a valid manifest declares. */
const SERVICE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export function isCapabilityId(capability: string): boolean {
  return AI_ID.test(capability) || SERVICE_ID.test(capability);
}
