// The allowlist: which senders a mailbox is read for, and the query that
// asks the source for only those.
//
// The list is the classifier's own store and carrier domains, one rule
// shared with the "is this a store's machine" test, plus the stores a person
// adds on the card. An EMPTY list asks for nothing: a query with no senders
// would be `after:…` alone, which is every email, and that is the one thing
// this file exists to make impossible.

import { STORE_SENDER_DOMAINS } from "../shipment-email.js";

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A person's extra stores, as typed: a domain, an address, or a pasted
 *  "Order from shop.example" is reduced to the domain, invalid entries are
 *  dropped, duplicates collapse. */
export function normalizeSenders(raw: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const r of raw ?? []) {
    let s = (r ?? "").trim().toLowerCase();
    if (!s) continue;
    const at = s.lastIndexOf("@");
    if (at >= 0) s = s.slice(at + 1);
    s = s.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";
    if (DOMAIN.test(s)) out.add(s);
  }
  return [...out].sort();
}

/** Every sender the mailbox is read for: the platform's list first. */
export function allowedSenders(extra: readonly string[] | undefined): string[] {
  const set = new Set<string>(STORE_SENDER_DOMAINS);
  for (const d of normalizeSenders(extra)) set.add(d);
  return [...set];
}

/** Gmail's query for "from any of these, since then". `after:` takes epoch
 *  seconds. Null when there is nobody to ask for, so the caller lists nothing
 *  rather than everything. */
export function gmailQuery(senders: readonly string[], sinceEpochSeconds: number): string | null {
  if (senders.length === 0) return null;
  const from = senders.map((d) => d.replace(/[^a-z0-9.-]/g, "")).filter(Boolean);
  if (from.length === 0) return null;
  return `from:(${from.join(" OR ")}) after:${Math.max(0, Math.floor(sinceEpochSeconds))}`;
}
