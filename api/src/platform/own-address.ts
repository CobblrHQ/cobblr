// The name on a person's own receipts or orders address (#5462): "Cobblr
// Receipts <workspace name>", always with the workspace, so the contact a
// person saves never changes when they join a second workspace.
//
// And the rule that keeps that name honest: only that workspace's own
// receipts+ (or orders+) address may carry it. A noreply address once went out
// named "Cobblr Receipts", Gmail learned the name for it, and receipts typed
// to "Cobblr Receipts" went to an address that files nothing. ownAddressFrom
// is applied to every email at the one send seam (sendAuthEmail), so no path
// can pair the name with anything else: such a From goes out named "Cobblr".

import { claimedOwnAddressKind, namedAddress, ownAddressName, splitFromHeader, type OwnAddressKind } from "@cobblr/platform-contract/address-name";
import { meta } from "../db/meta.js";
import { verifyReceiptToken } from "./receipt-email.js";

async function workspaceName(orgId: string): Promise<string | null> {
  const row = await meta.selectFrom("orgs").select("name").where("id", "=", orgId).executeTakeFirst();
  return row?.name ?? null;
}

export async function ownAddressNameFor(_userId: string, orgId: string, kind: OwnAddressKind): Promise<string> {
  return ownAddressName(kind, await workspaceName(orgId));
}

/** The From a message may really go out with. A name claiming to be a
 *  workspace's receipts or orders address stands only on that workspace's own
 *  signed address; anything else is renamed plain "Cobblr". */
export async function ownAddressFrom(from: string | undefined, lookup: (orgId: string) => Promise<string | null> = workspaceName): Promise<string | undefined> {
  if (!from) return from;
  const { name, address } = splitFromHeader(from);
  const kind = claimedOwnAddressKind(name);
  if (!kind) return from;
  const m = /^(receipts|orders)\+([^@]+)@/i.exec(address);
  const owner = m && m[1]!.toLowerCase() === kind ? verifyReceiptToken(m[2]!) : null;
  if (owner && name === ownAddressName(kind, await lookup(owner.orgId))) return from;
  return namedAddress("Cobblr", address);
}
