// The names a person's own Cobblr addresses go by (#5462).
//
// The receipts address is a long receipts+<token>@ string. Gmail suggests a
// recipient by the names and addresses it has had mail from, so with no name
// on it, typing "Cobblr" in the To field found nothing. Every email that flow
// sends now comes from the address itself, named "Cobblr Receipts" and its
// workspace, and only that address may carry that name, and the
// address card can mail it to the person or hand them a contact card, so the
// name is in their address book from day one.

export type OwnAddressKind = "receipts" | "orders";

const BASE: Record<OwnAddressKind, string> = { receipts: "Cobblr Receipts", orders: "Cobblr Orders" };

/** "Cobblr Receipts Alex's Workshop": the kind's name and the workspace's,
 *  always both, so a saved contact never changes when a second workspace
 *  comes along, and typing "Cobblr Receipts" still finds every one. */
export function ownAddressName(kind: OwnAddressKind, workspace: string | null | undefined): string {
  const w = (workspace ?? "").replace(/[\r\n"\\<>]/g, " ").replace(/\s+/g, " ").trim();
  return w ? `${BASE[kind]} ${w}` : BASE[kind];
}

/** Which own-address name a display name claims, if any. */
export function claimedOwnAddressKind(name: string | null | undefined): OwnAddressKind | null {
  const n = (name ?? "").trim().toLowerCase();
  if (n === "cobblr receipts" || n.startsWith("cobblr receipts ")) return "receipts";
  if (n === "cobblr orders" || n.startsWith("cobblr orders ")) return "orders";
  return null;
}

/** A From header's display name and address: `"Name" <a@b>`, `Name <a@b>` or `a@b`. */
export function splitFromHeader(from: string): { name: string | null; address: string } {
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<]*?))\s*<([^>]+)>\s*$/.exec(from);
  if (!m) return { name: null, address: from.trim() };
  const name = (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1").trim();
  return { name: name || null, address: (m[3] ?? "").trim() };
}

/** A From/To header value: the name quoted, so its parentheses are part of
 *  the name and not an RFC 5322 comment a mail client drops. */
export function namedAddress(name: string, address: string): string {
  return `"${name.replace(/["\\\r\n]/g, "")}" <${address}>`;
}

function vcardText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

/** A contact card (vCard 3.0) for one of the person's own addresses. */
export function ownAddressVCard(input: { name: string; address: string; workspace?: string | null }): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${vcardText(input.name)}`,
    `N:${vcardText(input.name)};;;;`,
    "ORG:Cobblr",
    `EMAIL;TYPE=INTERNET:${input.address}`,
    ...(input.workspace ? [`NOTE:${vcardText(`Forward receipts and order emails here to file them in ${input.workspace}.`)}`] : []),
    "END:VCARD",
  ];
  return lines.join("\r\n") + "\r\n";
}

/** What the card says once "Email it to me" has sent (#5462). A first email
 *  from a new address can land in Spam or Promotions; marking it "Not spam"
 *  is what lets the receipts flow's mail reach the inbox from then on. */
export function ownAddressSentWords(to: string, kind: OwnAddressKind): string {
  const flow = kind === "orders" ? "order" : "receipts";
  return `Sent to ${to}. Not in your inbox within a minute? Look in Spam or Promotions and mark it "Not spam", so ${flow} mail from Cobblr keeps arriving.`;
}
