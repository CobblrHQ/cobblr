// "That photo is a receipt, not a thing you own."
//
// Photographing a receipt with the scanner used to produce one inventory item
// named after whatever the vision pass could read off the paper: a Walmart
// receipt for one line of "16IN CHEESE" became an item called "Walmart 16in
// Cheese Pizza", which then went looking for stock photos of a pizza.
//
// Nothing has to be asked of the model to fix that. The identify pass already
// describes a receipt when it sees one, in `observations`.
//
// WHICH FIELD, and why not the obvious ones. Across nine real identifications
// of photographed receipts and product photos, from recorded replies and from
// live inbox rows:
//
//   signal                        true on receipts   true on products
//   entity_type === null                3 of 7            0 of 2
//   category === "receipt"              5 of 7            0 of 2
//   observations name a receipt         7 of 7            0 of 2
//
// The first version of this shipped on `entity_type === null`, because both
// recordings had it. The LIVE pipeline returns "part" for the same photographs:
// it passes the workspace's own category vocabulary into the call, and a
// workspace that has filed receipts before has "receipt" in that vocabulary. So
// the rule would have rejected every real receipt while its own tests stayed
// green, which is the whole reason the live shapes are now committed beside the
// recordings. The observations were right every time.
//
// The trap on the other side is that "receipt" is also a MODIFIER: a receipt
// printer, a roll of receipt paper. Those are things you own. So the word has to
// be the subject, and a category naming some other kind of thing wins outright.
//
// The corpus behind all of this: modules/core-scan/tests/receipt-photo-detect.test.ts

import { platform } from "@cobblr/platform-contract";

/** The fields this decision reads. A structural subset of PhotoIdentity, so the
 *  rule can be tested against a recorded reply or a stored row without building
 *  a whole identity. */
export interface ReceiptPhotoSignals {
  /** What the pass called the thing. Its primary verdict, and stronger than a
   *  category that only names a material. */
  name?: string | null;
  /** The pass's plain-English account of what is in the photo. */
  observations: string;
  /** What KIND of thing it decided this is, in the workspace's own vocabulary.
   *  Null or empty when it declined to say. */
  category: string | null;
}

/** The observations calling it one. "Ticket" and "docket" are deliberately
 *  absent: both have common non-receipt meanings, and this list only earns its
 *  keep while every word on it is decisive. */
const RECEIPT_NOUN =
  /\b(?:receipts?|invoices?|packing\s+slips?|bills?\s+of\s+sale|itemi[sz]ed\s+(?:bill|list))\b/i;

/** ...and the same word used as a MODIFIER for a thing you own. A receipt
 *  printer is a printer; a roll of receipt paper is stationery. */
const RECEIPT_AS_MODIFIER =
  /\b(?:receipts?|invoices?)\s+(?:printers?|papers?|rolls?|scanners?|holders?|books?|spikes?|trays?|pads?)\b/i;

/** A category that IS a receipt, rather than one naming another kind of thing. */
const RECEIPTY_CATEGORY = /^\s*(?:receipts?|invoices?)\s*$/i;

/**
 * Did the scanner just photograph a receipt?
 *
 * Conservative on the side that matters: whatever its prose mentions, a photo
 * the pass filed under some other kind of thing is that thing.
 */
export function looksLikeReceiptPhoto(id: ReceiptPhotoSignals): boolean {
  // Gate one: the description is ABOUT a receipt, not about a device for
  // printing them.
  const obs = id.observations ?? "";
  const name = id.name ?? "";
  // The pass's NAME is its primary verdict on what the thing IS - "Lidl grocery
  // store receipt" is not a hedge - so a name that says receipt settles it, and
  // only the modifier check can take it back ("receipt printer").
  const namesOne = RECEIPT_NOUN.test(name) && !RECEIPT_AS_MODIFIER.test(name);
  if (!RECEIPT_NOUN.test(obs) || RECEIPT_AS_MODIFIER.test(obs)) return false;
  if (namesOne) return true;
  // Gate two: the pass did not land on some other kind of thing. A category is
  // its own verdict on what this IS, so "cooking oil" outranks anything the
  // prose happens to mention; "receipt", or no category at all, does not.
  //
  // Only reached when the NAME did not already settle it, which is what keeps
  // this from vetoing a receipt over a material. Re-recording the fixtures
  // returned category "paper" for a photo the model had named a receipt, and
  // this gate rejected it - "paper" describes what a receipt is MADE OF, not a
  // different thing to own (2026-08-24).
  const cat = (id.category ?? "").trim();
  if (cat && !RECEIPTY_CATEGORY.test(cat)) return false;
  return true;
}

// ── routing it, once detected ───────────────────────────────────────────────
//
// The receipt flow is not re-implemented here. It is a long one - a batch, one
// inbox row per line, a purchases order with every line on it - and it already
// exists behind POST /scan/receipt. So this does what the EMAILED receipt path
// does: mint a session and post the file to that same route. One code path, so
// a receipt photographed with the scanner cannot drift from one uploaded, and
// nothing about orders or batches is duplicated in a second place.
//
// (email-inbound.ts is the precedent, verbatim: mintSession → INTERNAL_API POST.)

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

/** The workspace slug, plus a member to attribute the capture to when the
 *  scanning user is not in scope (a detached run). Highest role wins. */
async function workspaceIdentity(orgId: string): Promise<{ userId: string; slug: string } | null> {
  const meta = platform().db.meta as unknown as {
    selectFrom: (t: string) => {
      select: (cols: string[]) => {
        where: (c: string, op: string, v: unknown) => {
          execute: () => Promise<Array<Record<string, unknown>>>;
          executeTakeFirst: () => Promise<Record<string, unknown> | undefined>;
        };
      };
    };
  };
  const members = (await meta
    .selectFrom("org_memberships")
    .select(["user_id", "role"])
    .where("org_id", "=", orgId)
    .execute()) as Array<{ user_id: string; role: string }>;
  if (members.length === 0) return null;
  const RANK: Record<string, number> = { owner: 0, admin: 1, editor: 2, member: 3 };
  const pick = [...members].sort((a, b) => (RANK[a.role] ?? 9) - (RANK[b.role] ?? 9))[0]!;
  const org = (await meta
    .selectFrom("orgs")
    .select(["slug"])
    .where("id", "=", orgId)
    .executeTakeFirst()) as { slug: string } | undefined;
  if (!org?.slug) return null;
  return { userId: pick.user_id, slug: org.slug };
}

export type ReceiptRouteResult =
  | { routed: true; items: number }
  | { routed: false; reason: string };

/**
 * Hand a photographed receipt to the receipt parser.
 *
 * On success the photo's own inbox row is retired: its picture is not lost, the
 * batch keeps it as the source the lines were read from, and the session offers
 * "View original" over it exactly as an uploaded receipt does.
 *
 * On failure the row is LEFT ALONE. A photo we called a receipt and could not
 * read is still the user's photo, and deleting it because we guessed wrong would
 * be much worse than a nameless row they can re-run.
 */
export async function routeScannedReceiptPhoto(opts: {
  orgId: string;
  itemId: string;
  fileId: string;
  userId?: string | null;
}): Promise<ReceiptRouteResult> {
  const who = await workspaceIdentity(opts.orgId);
  if (!who) return { routed: false, reason: "no member to attribute the capture to" };

  let token: string;
  try {
    token = await platform().auth.mintSession({ userId: opts.userId ?? who.userId });
  } catch (e) {
    return { routed: false, reason: `couldn't mint a capture session: ${(e as Error).message}` };
  }

  let body: { receipt?: { item_count?: number } } = {};
  try {
    const r = await fetch(
      `${INTERNAL_API}/api/v1/orgs/${who.slug}/modules/core-scan/scan/receipt`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ file_id: opts.fileId }),
      },
    );
    body = (await r.json()) as typeof body;
    if (!r.ok) return { routed: false, reason: `receipt parse returned ${r.status}` };
  } catch (e) {
    return { routed: false, reason: (e as Error).message };
  }

  const items = body.receipt?.item_count ?? 0;
  if (!items) return { routed: false, reason: "no line items on it" };

  // The lines are in, so the single photo row has been superseded. Retire it
  // rather than leaving a nameless duplicate of the receipt beside its own line
  // items. The picture survives on the batch as the source it was read from.
  try {
    const db = (await platform().tenants.getDb(opts.orgId)) as unknown as {
      updateTable: (t: string) => {
        set: (v: Record<string, unknown>) => {
          where: (c: string, op: string, v: unknown) => { execute: () => Promise<unknown> };
        };
      };
    };
    await db
      .updateTable("core_scan_inbox_items")
      .set({ status: "discarded", updated_at: new Date() })
      .where("id", "=", opts.itemId)
      .execute();
  } catch (e) {
    // The receipt landed either way; a stray row is untidy, not broken.
    console.error("[core-scan] retiring the photographed receipt row failed:", (e as Error).message);
  }
  return { routed: true, items };
}
