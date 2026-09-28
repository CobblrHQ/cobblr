// What a personal token dialog starts on, and how a token reads in the list.
// Pure so the rule "a new token is never full access by default" is held by a
// test rather than by whoever next edits the dialog.
import { DEFAULT_TOKEN_ACCESS, TOKEN_ACCESS_LABEL, type TokenAccess } from "@cobblr/platform-contract/token-access";

export interface TokenGrant {
  /** A workspace id, or null for every workspace. */
  workspace: string | null;
  access: TokenAccess;
}

/** Where a mint dialog starts. A replacement keeps what the old token had,
 *  unless the old one predates access levels (full, every workspace): then it
 *  starts narrow, because narrowing is the reason to rotate one. */
export function initialGrant(
  activeOrgId: string | null,
  replacing?: { access?: TokenAccess | null; org_id?: string | null } | null,
): TokenGrant {
  if (replacing && (replacing.access || replacing.org_id)) {
    return { workspace: replacing.org_id ?? null, access: replacing.access ?? "full" };
  }
  return { workspace: activeOrgId, access: DEFAULT_TOKEN_ACCESS };
}

/** A token from before access levels: no scopes, no workspace, no access. */
export function isLegacyFullToken(t: { scopes?: string[] | null; access?: string | null; org_id?: string | null }): boolean {
  return !(t.scopes && t.scopes.length > 0) && !t.access && !t.org_id;
}

/** "Look only · Shop", "Full access, all workspaces". */
export function grantLabel(t: { access?: TokenAccess | null; org_name?: string | null; org_id?: string | null }): string {
  const access = TOKEN_ACCESS_LABEL[t.access ?? "full"];
  if (!t.org_id) return `${access}, all workspaces`;
  return `${access} · ${t.org_name ?? "one workspace"}`;
}
