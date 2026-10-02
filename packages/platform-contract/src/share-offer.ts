// Things handed over between the two sides of a share
// (docs/design-decisions/share-spaces.md §6).
//
// A thing offered travels as an OfferedThing: what it is called, what it
// says, its photos inline. It arrives in the receiver's scan inbox, where a
// person takes it, passes on it or leaves it for later. The kernel owns the
// offer (who gave it, its state, the link it crossed); the scan inbox owns the
// row it became. Neither reaches into the other: the inbox asks the kernel to
// record a decision, and the kernel asks the inbox to receive or remove a row.

/** Where an offer stands. Offered and maybe are still open; the rest are
 *  answers. */
export const OFFER_STATES = ["offered", "maybe", "taken", "passed", "withdrawn", "returned"] as const;
export type OfferState = (typeof OFFER_STATES)[number];
export type OfferDecision = "taken" | "passed" | "maybe";

/** How long after taking a thing it can be sent back. */
export const SEND_BACK_DAYS = 14;

export interface OfferedPhoto {
  mime: string;
  /** base64 */
  data: string;
}

export interface OfferedThing {
  name: string;
  manufacturer?: string | null;
  model?: string | null;
  /** What kind of thing it was on the giver's side, in words ("3D printer"),
   *  a hint for where it files; never a kind id the receiver must have. */
  kind_words?: string | null;
  quantity?: number | null;
  notes?: string | null;
  /** The giver's field values by their labels ("Nozzle": "0.4 mm"). */
  fields?: Record<string, string>;
  photos: OfferedPhoto[];
}

/** What an inbox row that came as an offer carries in its metadata. */
export interface InboxOfferMark {
  offer_id: string;
  /** Who offered it, as the receiver's side knows them. */
  from: string;
  state: OfferState;
}
export const INBOX_OFFER_KEY = "share_offer";

export function readInboxOffer(metadata: unknown): InboxOfferMark | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = (metadata as Record<string, unknown>)[INBOX_OFFER_KEY];
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  if (typeof o.offer_id !== "string" || typeof o.from !== "string") return null;
  const state = (OFFER_STATES as readonly string[]).includes(String(o.state)) ? (o.state as OfferState) : "offered";
  return { offer_id: o.offer_id, from: o.from, state };
}

/** What a giver's record carries while it is offered. */
export interface RecordOfferMark {
  offer_id: string;
  to: string;
}
export const RECORD_OFFER_KEY = "share_offered";

export function readRecordOffer(metadata: unknown): RecordOfferMark | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = (metadata as Record<string, unknown>)[RECORD_OFFER_KEY];
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  return typeof o.offer_id === "string" && typeof o.to === "string" ? { offer_id: o.offer_id, to: o.to } : null;
}

/** The scan inbox's side of a hand-over, registered by the module that owns
 *  the inbox. */
export interface OfferIntake {
  /** Put offered things into a workspace's inbox as one session, each marked
   *  as offered. A thing whose offer id is already there is left as it is. */
  receive(
    orgId: string,
    p: {
      session: { key: string; label: string; from: string };
      things: Array<{ offer_id: string; thing: OfferedThing }>;
      /** Who it is from and the day, so filing it says where it came from. */
      acquiredFrom: string;
      acquiredOn: string;
      /** A member of the receiving workspace to route the rows as (which of
       *  its tables each thing belongs in), and the workspace's slug. Without
       *  it the rows land unrouted and a person picks the table. */
      as?: { userId: string; orgSlug: string } | null;
    },
  ): Promise<Array<{ offer_id: string; inbox_id: string }>>;
  /** Where an inbox row stands: waiting, filed as a record, or gone. */
  state(orgId: string, inboxId: string): Promise<{ status: "waiting" | "filed" | "gone"; record?: { kind: string; id: string } }>;
  /** Set the offer state an inbox row shows. */
  mark(orgId: string, inboxId: string, state: OfferState): Promise<void>;
  /** Take a row that is still waiting out of the inbox (kept, discarded).
   *  False when it was already filed or gone. */
  remove(orgId: string, inboxId: string): Promise<boolean>;
  /** Put a removed row back in the inbox, waiting. */
  restore(orgId: string, inboxId: string): Promise<boolean>;
  /** An inbox row as a thing to offer. Null when it is gone. */
  asThing(orgId: string, inboxId: string): Promise<OfferedThing | null>;
}
