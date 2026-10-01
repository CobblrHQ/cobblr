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

// The service shape is the manifest validator's own, imported through the
// package's subpath (the api loads this as .ts, where a relative ./x.js does
// not exist; lint:contract-sibling-imports).
import { SERVICE_CAPABILITY_ID } from "@cobblr/platform-contract/services";

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
 *  (a service, the manifest validator's own SERVICE_CAPABILITY_ID, so ranking
 *  never refuses an id a valid manifest declares). */
export const AI_CAPABILITY_ID = /^[a-z][a-z0-9-]*$/;

export function isCapabilityId(capability: string): boolean {
  return AI_CAPABILITY_ID.test(capability) || SERVICE_CAPABILITY_ID.test(capability);
}
