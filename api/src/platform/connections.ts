// The registry behind /me/connections — providers a USER connects, as opposed
// to ones a workspace owns.
//
// AI was the first kind and for a while the only one, so the surface hardcoded
// it: the catalogue WAS the AI provider list, and anything else was rejected
// with "No such AI provider." That was a naming accident rather than a design.
// Look at user-credentials.ts and nothing in it mentions AI — the per-workspace
// routing, the owner-approval flow for a shared connection, and the precedence
// rules are all about WHO a credential belongs to and WHERE they pointed it.
//
// So a second kind is a registration here, not a second copy of any of that.
// AI keeps its own catalogue (it carries capabilities + models this shape has
// no place for) and is projected in; other kinds register directly.

import type { ConnectionProviderDef, ResolvedConnection } from "@cobblr/platform-contract";
import * as aiImpl from "./ai.js";
import { resolvePersonalProvider } from "./user-credentials.js";

/** The kind AI credentials have carried since migration 053. Existing rows say
 *  this, so it stays the wire value rather than being tidied to "ai". */
export const AI_KIND = "ai-provider";

const registered = new Map<string, ConnectionProviderDef>();

export function registerProvider(p: ConnectionProviderDef): void {
  registered.set(p.id, p);
}

/** AI's providers in this shape, so one catalogue serves the whole page. */
function aiProviders(): ConnectionProviderDef[] {
  return aiImpl.listProviders().map((p) => ({
    id: p.id,
    kind: AI_KIND,
    label: p.label,
    credentials: p.credentials,
  }));
}

export function listProviders(kind?: string): ConnectionProviderDef[] {
  const all = [...aiProviders(), ...registered.values()];
  return kind ? all.filter((p) => p.kind === kind) : all;
}

export function getProvider(id: string): ConnectionProviderDef | null {
  // A registered provider wins a name collision with an AI one. Neither ships
  // with a clashing id today; deciding it here beats an order-dependent answer.
  return registered.get(id) ?? aiProviders().find((p) => p.id === id) ?? null;
}

/** Per-(provider, field) secrecy across BOTH catalogues, so a value can be
 *  returned for pre-filling a form only when its provider says it is not a
 *  secret. An unknown provider or field is treated as secret — the safe way to
 *  be wrong is to withhold. */
export function secretLookup(): (providerId: string, key: string) => boolean {
  const map = new Map<string, Set<string>>();
  for (const p of listProviders()) {
    const secrets = new Set<string>();
    for (const [k, def] of Object.entries(p.credentials ?? {})) if (def.secret) secrets.add(k);
    map.set(p.id, secrets);
  }
  return (providerId, key) => map.get(providerId)?.has(key) ?? true;
}

export async function resolve(
  kind: string,
  orgId: string,
  callerUserId: string | null,
): Promise<ResolvedConnection | null> {
  // "Supports" for a non-AI kind is simply "registered under this kind". The
  // kind is also filtered in SQL; this guards the case where a provider was
  // un-registered (a module disabled) while its rows remain.
  const supported = (id: string): boolean => registered.get(id)?.kind === kind;
  const found = await resolvePersonalProvider(orgId, callerUserId, supported, kind);
  if (!found) return null;
  return {
    credentialId: found.credentialId,
    providerId: found.providerId,
    credentials: found.credentials,
    label: found.label,
    ownerUserId: found.ownerUserId,
  };
}
