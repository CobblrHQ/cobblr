// A token minted with another token is that token's child, and a child never
// outlives or out-reaches its parent: it expires no later, reaches no other
// workspace, carries no scope or access its parent lacks, and dies with it.
//
// Before this a full-access token could POST /me/api-tokens and mint a key
// with no expiry, no workspace and no scopes, so a one-hour token handed to a
// script became a permanent, unrestricted credential that its revocation did
// not touch.
import type { TokenAccess } from "./token-access.js";

export interface TokenTerms {
  expires_at: Date | null;
  org_id: string | null;
  scopes: string[] | null;
  /** null = full (every token before access levels). */
  access: TokenAccess | null;
}

const RANK: Record<TokenAccess, number> = { look: 0, change: 1, full: 2 };
const rankOf = (a: TokenAccess | null) => RANK[a ?? "full"];

/** The terms a child may have, given what was asked for. Unset asks take the
 *  parent's; an ask beyond the parent is refused with the reason. */
export function childTerms(parent: TokenTerms, asked: Partial<TokenTerms> & { expires_at?: Date | null }): { ok: true; terms: TokenTerms } | { ok: false; message: string } {
  let expires = asked.expires_at ?? null;
  if (parent.expires_at) {
    if (!expires) expires = parent.expires_at;
    else if (expires > parent.expires_at) return { ok: false, message: `A token made with another token cannot outlive it: this one expires at ${parent.expires_at.toISOString()}.` };
  }
  let orgId = asked.org_id ?? null;
  if (parent.org_id) {
    if (!orgId) orgId = parent.org_id;
    else if (orgId !== parent.org_id) return { ok: false, message: "A token made with another token reaches only the workspace its parent reaches." };
  }
  let scopes = asked.scopes && asked.scopes.length ? asked.scopes : null;
  if (parent.scopes && parent.scopes.length) {
    if (!scopes) scopes = parent.scopes;
    const beyond = scopes.filter((s) => !parent.scopes!.includes(s));
    if (beyond.length) return { ok: false, message: `A token made with another token cannot carry what its parent lacks: ${beyond.join(", ")}.` };
  }
  let access = asked.access ?? null;
  if (parent.access && !access) access = parent.access;
  if (rankOf(access) > rankOf(parent.access)) return { ok: false, message: `A token made with another token cannot have more access than it (${parent.access ?? "full"}).` };
  return { ok: true, terms: { expires_at: expires, org_id: orgId, scopes, access } };
}
