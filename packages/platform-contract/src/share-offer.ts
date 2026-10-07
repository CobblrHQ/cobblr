import { canonicalJson } from "@cobblr/platform-contract/service-consent";
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
  /** The collection it was kept in on the giver's side: its module and, for
   *  a collection of its own ("3d-printers"), the instance. The receiver files
   *  it where they keep the same collection, the most specific first (#4682);
   *  a hint, never a table the receiver must have. */
  collection?: { module: string; instance: string | null } | null;
  /** The giver's field values by their labels ("Nozzle": "0.4 mm"). */
  fields?: Record<string, string>;
  photos: OfferedPhoto[];
  send?: {
    version: 1;
    mode: "copy" | "move";
    origin: { instance: string; org: string; kind: string; id: string };
    module_version: string;
    kind_version: string;
    values: Record<string, unknown>;
    references?: Array<{ label: string; value: unknown }>;
    files: Array<OfferedPhoto & { filename: string; role: string | null; sort_order: number }>;
    needs: string[];
    target_kind: string | null;
    mapped: Record<string, unknown>;
    field_map?: Record<string, string | null>;
    location: string | null;
  };
}

/** What an inbox row that came as an offer carries in its metadata. */
export interface InboxOfferMark {
  offer_id: string;
  /** Who offered it, as the receiver's side knows them. */
  from: string;
  state: OfferState;
  own?: boolean;
  needs?: string[];
  mode?: "copy" | "move";
}
export const INBOX_OFFER_KEY = "share_offer";

export function readInboxOffer(metadata: unknown): InboxOfferMark | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = (metadata as Record<string, unknown>)[INBOX_OFFER_KEY];
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  if (typeof o.offer_id !== "string" || typeof o.from !== "string") return null;
  const state = (OFFER_STATES as readonly string[]).includes(String(o.state)) ? (o.state as OfferState) : "offered";
  return { offer_id: o.offer_id, from: o.from, state, ...(o.own === true ? { own: true, needs: Array.isArray(o.needs) ? o.needs.filter((n): n is string => typeof n === "string") : [], mode: o.mode === "move" ? "move" : "copy" } : {}) };
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
      own?: boolean;
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
  room?(orgId: string, as: { userId: string; orgSlug: string }, p: { count: number; bytes: number }): Promise<string[]>;
  file?(orgId: string, inboxId: string, as: { userId: string; orgSlug: string }): Promise<{ kind: string; id: string }>;
  retarget?(orgId: string, inboxId: string, record: {kind: string; id: string}): Promise<string[]>;
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

/** The event the platform announces when a comment on a shared record arrives
 *  from the other side of a share (share-spaces.md §12): `{ orgId, kind, id,
 *  body, author_name, external_ref }`. The discussion module puts it in the
 *  record's conversation as a guest's. One name, here, for both ends. */
export const SHARE_COMMENT_ARRIVED = "platform.share.comment-arrived";

export function mapOfferedFields(
  values: Record<string, unknown>,
  fields: readonly { name: string; display_label?: string | null; type: string; native?: boolean }[],
  fieldMap: Record<string, string | null> = {},
): { values: Record<string, unknown>; missing: string[]; dropped: string[]; mappings: Array<{ from: string; to: string | null }> } {
  const key = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const out: ReturnType<typeof mapOfferedFields> = { values: {}, missing: [], dropped: [], mappings: [] };
  const used = new Set<string>();
  for (const [label, value] of Object.entries(values)) {
    if (Object.hasOwn(fieldMap, label) && fieldMap[label] === null) {
      out.dropped.push(label);
      out.mappings.push({ from: label, to: null });
      continue;
    }
    const matches = fields.filter((f) => f.type !== "computed" && (fieldMap[label] ? f.name === fieldMap[label] : key(f.display_label || f.name) === key(label) || key(f.name) === key(label)));
    const f = matches.length === 1 ? matches[0] : undefined;
    const fits = f && (f.type === "number" ? typeof value === "number" && Number.isFinite(value) : f.type === "boolean" ? typeof value === "boolean" : ["text", "textarea", "url", "select", "date", "datetime"].includes(f.type) ? typeof value === "string" || value instanceof Date : true);
    if (!f || !fits || used.has(f.name)) {
      out.missing.push(label);
      out.mappings.push({ from: label, to: null });
    } else {
      used.add(f.name);
      out.values[f.name] = value;
      out.mappings.push({ from: label, to: f.display_label || f.name });
    }
  }
  return out;
}

export function incomingThingForInbox(thing: OfferedThing, own = false): OfferedThing {
  if (own) return thing;
  const {send, ...offered} = thing;
  void send;
  return offered;
}

export function canUndoOwnMove(writer: import("./index.js").EntityWriter | null): boolean {
  return !!writer && !!((writer.retire && writer.unretire) || (writer.snapshot && writer.restore));
}

export function sameSendSnapshot(left: unknown, right: unknown): boolean {
  return canonicalJson(JSON.parse(JSON.stringify(left ?? null))) === canonicalJson(JSON.parse(JSON.stringify(right ?? null)));
}
