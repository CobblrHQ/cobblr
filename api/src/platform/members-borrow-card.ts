// The one-time question to an older workspace's owner: members cannot lend
// and return things, as a makerspace's members need to; allow it? (#8661)
//
// A workspace born after migration 250 allows it from the start and is never
// asked; an older one is asked once, because an update never opts anyone in.
// Either answer ends the question (members_lend_asked), and the answer is the
// platform:set-members-may-lend action, so the card, the assistant and the
// MCP server share one door.
import { ADMIN_TIER } from "@cobblr/platform-contract/org-roles";

export interface MembersBorrowCard {
  kind: "members_borrow";
  label: string;
  count: number;
  sample: string[];
  route: string;
}

/** The card, or null: it shows to an owner or admin, only until answered, and only where a plain member exists to borrow. */
export function membersBorrowCard(o: { role: string | undefined; asked: boolean; plainMembers: number }): MembersBorrowCard | null {
  if (!(ADMIN_TIER as readonly string[]).includes(o.role ?? "") || o.asked || o.plainMembers < 1) return null;
  return {
    kind: "members_borrow",
    label: "Members can't borrow things yet. Allow them to lend and return?",
    count: 1,
    sample: [],
    route: "/configuration/members",
  };
}
