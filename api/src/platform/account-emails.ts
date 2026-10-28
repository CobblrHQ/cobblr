// Who may read the address an account signed up with (#8659).
//
// A makerspace of two hundred members is not a mailing list every member can
// export: a member sees the names of the people they share a workspace with,
// and an owner or admin sees their addresses. One rule, read by every door that
// names an account (the members list, the People list, the activity feed and so
// the assistant and the MCP server that read it), so a new door asks here instead
// of copying the column. A person always sees their own address.
//
// What this is not: a contact's address on the People list (someone entered by
// hand, with no account) is the workspace's own address book, a record like any
// other, and stays readable.
import { ADMIN_TIER } from "@cobblr/platform-contract/org-roles";

// Exact, not by rank: an editor ties with admin for actions, but who is in the
// workspace (and where to reach them) is governance, which an editor lacks.
export const seesAccountEmails = (role: string | undefined): boolean => (ADMIN_TIER as readonly string[]).includes(role ?? "");

/** The address as this reader may see it: all of them for an owner or admin, their own for anyone else. */
export function accountEmailFor<T extends string | null | undefined>(viewer: { id: string; role: string | undefined }, subjectUserId: string | null | undefined, email: T): T | null {
  return seesAccountEmails(viewer.role) || (subjectUserId != null && subjectUserId === viewer.id) ? email : null;
}

/** An activity row's diff without an address someone else typed in: an invite names who it was sent to. */
export function diffWithoutEmails(diff: unknown): unknown {
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) return diff;
  const { email: _email, invited_email: _invited, ...rest } = diff as Record<string, unknown>;
  return rest;
}

/** An answer with every address of another account, or of someone invited, said as "another member".
 *  For a door whose words come from many sources (a feed row's sentence, its diff, its subject's
 *  title): the sources that name an address are cleaned one by one, and this is what stops the
 *  next one that is not. Only addresses that belong to an account or an invite: a contact's
 *  address typed into a record stays as the workspace wrote it. */
export function withoutOtherEmails<T>(answer: T, addresses: readonly string[]): T {
  const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))];
  if (!unique.length) return answer;
  const pattern = new RegExp(unique.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return JSON.parse(JSON.stringify(answer).replace(pattern, "another member")) as T;
}
