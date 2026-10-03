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
import { sql } from "kysely";
import { HOSTED_RECEIPT_QUEUED_WORDS } from "./hosted-identify.js";

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
  /** The pass's own answer to the question, asked as a field (#2916). Absent
   *  on a reply from before the prompt asked, when the prose decides. */
  is_receipt?: "yes" | "no" | "unsure" | null;
}

/** What the receipt-shape check (receipt-shape.ts) made of the image's own
 *  text, for the one case where the model hedges: an "unsure" lands on the
 *  receipt side when the text had any receipt shape to it. */
export type ReceiptShapeHint = "receipt" | "maybe" | "not";

/** The observations calling it one. "Ticket" and "docket" are deliberately
 *  absent: both have common non-receipt meanings, and this list only earns its
 *  keep while every word on it is decisive. */
const RECEIPT_NOUN =
  /\b(?:receipts?|invoices?|packing\s+slips?|bills?\s+of\s+sale|itemi[sz]ed\s+(?:bill|list))\b/i;

/** ...and the same word used as a MODIFIER for a thing you own. A receipt
 *  printer is a printer; a roll of receipt paper is stationery. */
const RECEIPT_AS_MODIFIER =
  /\b(?:receipts?|invoices?)\s+(?:printers?|papers?|rolls?|scanners?|holders?|books?|spikes?|trays?|pads?|organi[sz]ers?|envelopes?|folders?|binders?|box(?:es)?)\b/i;

/** A category that IS a receipt, rather than one naming another kind of thing. */
const RECEIPTY_CATEGORY = /^\s*(?:receipts?|invoices?)\s*$/i;

/**
 * Did the scanner just photograph a receipt?
 *
 * Conservative on the side that matters: whatever its prose mentions, a photo
 * the pass filed under some other kind of thing is that thing.
 */
export function looksLikeReceiptPhoto(id: ReceiptPhotoSignals, shape: ReceiptShapeHint = "not"): boolean {
  const obs = id.observations ?? "";
  const name = id.name ?? "";
  // The field first, when the pass answered it: that is the verdict as data,
  // which is what the prose rules below were always standing in for. A "yes"
  // settles it. An "unsure" is settled by the image's own text: any receipt
  // shape to it and it goes to receipt review, where a wrong guess costs one
  // parse and a one-tap "identify it as an item instead"; the other way round
  // costs a receipt filed as a thing you own. A "no" still yields to a NAME
  // that says receipt (the pass's primary verdict, and a contradiction the
  // modifier rule below already knows how to read); the observations gate is
  // then skipped, because "no" is exactly the answer it was guessing at.
  if (id.is_receipt === "yes") return true;
  if (id.is_receipt === "unsure" && shape !== "not") return true;
  // The pass's NAME is its primary verdict on what the thing IS - "Lidl grocery
  // store receipt" is not a hedge - so a name that says receipt settles it, and
  // only the modifier check can take it back ("receipt printer").
  //
  // FIRST. This paragraph was already here, and the code under it disagreed
  // with it: the observations gate below ran before the name was read, so a
  // photo the pass had NAMED "Walmart printed receipt, White" was filed as a
  // product whenever its prose happened not to say the word - and on the
  // hosted path the prose can be empty, which made the name the only signal
  // there was and the one thing this never looked at (reported 2026-09-04,
  // "this failed to morph. Again.").
  if (RECEIPT_NOUN.test(name) && !RECEIPT_AS_MODIFIER.test(name)) return true;
  if (id.is_receipt === "no") return false;
  // Gate one, for a name that did not settle it: the description is ABOUT a
  // receipt, not about a device for printing them.
  if (!RECEIPT_NOUN.test(obs) || RECEIPT_AS_MODIFIER.test(obs)) return false;
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
export async function workspaceIdentity(orgId: string): Promise<{ userId: string; slug: string } | null> {
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
  | {
      routed: false;
      /** For the log and the API reply. */
      reason: string;
      /** The receipt door's own coded failure, when it answered. */
      failure?: string;
      ai?: string;
      /** The sentence written under the photo. */
      note: string;
      /** Waiting on the hosted identify's queue, not failed. */
      queued?: boolean;
    };

/** A door-sized tenant handle: the two writes this file makes. */
type RowDb = {
  updateTable: (t: string) => {
    set: (v: Record<string, unknown>) => {
      where: (c: string, op: string, v: unknown) => { execute: () => Promise<unknown> };
    };
  };
  deleteFrom: (t: string) => {
    where: (c: string, op: string, v: unknown) => { execute: () => Promise<unknown> };
  };
};

/** The photo stays the person's photo when it could not be read as a receipt:
 *  the "reading its line items" flag comes off (it used to stay on, and the
 *  card said "reading…" for ever over a read that had already failed), the
 *  note says what happened in the door's own words, and the row keeps its
 *  Identify and "Read as a receipt" ways out. The failed session the door kept
 *  for its own callers is withdrawn: that state belongs to a receipt somebody
 *  SAID was one; a guess that did not read out is one thing, not two. */
/** What a failed read leaves on the row, beside its note: the row IS a
 *  receipt whose lines could not be read, so every surface shows Read again
 *  rather than asking for a name (scanReceiptReadFailed in the contract;
 *  #3581). The note is the sentence; this is the state. */
export interface ReceiptReadFailed {
  failure: string | null;
  ai: string | null;
  at: string;
  /** The session this receipt is already in, when that is why it stopped. */
  duplicate_of?: { batch_id: string; label: string | null; lines: number };
}

/** What the receipt door answered, read ONE way (#4027). It answers a receipt
 *  it already holds with `{ duplicate, existing }` and no `receipt`; reading
 *  `receipt.item_count` off that answer as 0 reported a receipt already in the
 *  inbox as one with "no line items". Every shape is named here, and one this
 *  does not know is said to be unknown, never read as empty. */
export type ReceiptAnswer =
  | { kind: "read"; items: number }
  | { kind: "empty" }
  | { kind: "already-in"; batch_id: string; label: string | null; lines: number }
  | { kind: "refused"; status: number; failure?: string; ai?: string; message?: string; keptBatchId: string | null }
  | { kind: "unknown"; status: number }
  /** The hosted identify queued it (barcode-intelligence #43): read later. */
  | { kind: "queued"; jobId: string; message: string | null };

export function readReceiptAnswer(status: number, body: unknown): ReceiptAnswer {
  const b = (body ?? {}) as {
    receipt?: { item_count?: unknown };
    duplicate?: unknown;
    existing?: { batch_id?: unknown; label?: unknown; item_count?: unknown };
    error?: { message?: string; failure?: string; ai?: string };
    kept_batch_id?: string;
    queued?: { job_id?: unknown };
    message?: unknown;
  };
  if (status === 202 && typeof b.queued?.job_id === "string") {
    return { kind: "queued", jobId: b.queued.job_id, message: typeof b.message === "string" ? b.message : null };
  }
  if (status < 200 || status >= 300) {
    return { kind: "refused", status, failure: b.error?.failure, ai: b.error?.ai, message: b.error?.message, keptBatchId: b.kept_batch_id ?? null };
  }
  if (b.duplicate === true && typeof b.existing?.batch_id === "string") {
    return {
      kind: "already-in",
      batch_id: b.existing.batch_id,
      label: typeof b.existing.label === "string" ? b.existing.label : null,
      lines: typeof b.existing.item_count === "number" ? b.existing.item_count : 0,
    };
  }
  if (b.receipt && typeof b.receipt === "object") {
    const n = Number(b.receipt.item_count ?? 0);
    return n > 0 ? { kind: "read", items: n } : { kind: "empty" };
  }
  return { kind: "unknown", status };
}

async function leaveAsPhoto(
  opts: { orgId: string; itemId: string },
  note: string,
  keptBatchId: string | null,
  why: { failure?: string; ai?: string; duplicateOf?: ReceiptReadFailed["duplicate_of"] } = {},
): Promise<void> {
  const state: ReceiptReadFailed = {
    failure: why.failure ?? null,
    ai: why.ai ?? null,
    at: new Date().toISOString(),
    ...(why.duplicateOf ? { duplicate_of: why.duplicateOf } : {}),
  };
  try {
    const db = (await platform().tenants.getDb(opts.orgId)) as unknown as RowDb;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_notes: note,
        ai_suggested_at: new Date(),
        updated_at: new Date(),
        suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'reading_receipt' - 'read_as_item') || jsonb_build_object('receipt_read_failed', ${JSON.stringify(state)}::jsonb)`,
      })
      .where("id", "=", opts.itemId)
      .execute();
    if (keptBatchId) await db.deleteFrom("core_scan_batches").where("id", "=", keptBatchId).execute();
  } catch (e) {
    console.error("[core-scan] leaving the photographed receipt as a photo failed:", (e as Error).message);
  }
}

/**
 * Hand a photographed receipt to the receipt parser.
 *
 * On success the photo's own inbox row is retired: its picture is not lost, the
 * batch keeps it as the source the lines were read from, and the session offers
 * "View original" over it exactly as an uploaded receipt does.
 *
 * On failure the row is LEFT AS THE PHOTO IT WAS, with the reason on it. A
 * photo we called a receipt and could not read is still the user's photo, and
 * deleting it because we guessed wrong would be much worse than a row they can
 * re-run or read as a receipt again.
 */
export async function routeScannedReceiptPhoto(opts: {
  orgId: string;
  itemId: string;
  fileId: string;
  userId?: string | null;
  /** Read it in even when the door recognises it as a receipt already here. */
  force?: boolean;
  /** A queued hosted read that finished (hosted-identify-job.ts): its
   *  answer is collected by the door, not asked for again. */
  hostedJobId?: string;
}): Promise<ReceiptRouteResult> {
  const failed = async (
    reason: string,
    door?: { failure?: string; ai?: string; message?: string; keptBatchId?: string | null; duplicateOf?: ReceiptReadFailed["duplicate_of"] },
  ): Promise<ReceiptRouteResult> => {
    // The door's sentence already says what to do ("Couldn't be read: no AI
    // provider is connected. Connect one…, then read it again."); this only
    // says what the photo was taken for.
    const note = door?.message
      ? `That looked like a receipt, but it ${door.message.replace(/^Couldn't/, "couldn't")} Or identify it as an item instead.`
      : `That looked like a receipt, but its line items could not be read (${reason}). Read it as a receipt again, or identify it as an item instead.`;
    await leaveAsPhoto(opts, note, door?.keptBatchId ?? null, { failure: door?.failure, ai: door?.ai, duplicateOf: door?.duplicateOf });
    return { routed: false, reason, note, ...(door?.failure ? { failure: door.failure } : {}), ...(door?.ai ? { ai: door.ai } : {}) };
  };

  const who = await workspaceIdentity(opts.orgId);
  if (!who) return failed("no member to attribute the capture to");

  let token: string;
  try {
    token = await platform().auth.mintSession({ userId: opts.userId ?? who.userId });
  } catch (e) {
    return failed(`couldn't mint a capture session: ${(e as Error).message}`);
  }

  let answer: ReceiptAnswer;
  try {
    const r = await fetch(
      `${INTERNAL_API}/api/v1/orgs/${who.slug}/modules/core-scan/scan/receipt`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        // This route has a row to wait on, so a read the hosted identify
        // queued waits here instead of being read the old way (#43).
        body: JSON.stringify({ file_id: opts.fileId, queue_if_busy: true, ...(opts.hostedJobId ? { hosted_job_id: opts.hostedJobId } : {}), ...(opts.force ? { force: true } : {}) }),
      },
    );
    answer = readReceiptAnswer(r.status, await r.json().catch(() => null));
  } catch (e) {
    return failed((e as Error).message);
  }

  if (answer.kind === "queued") {
    // Reading, not failed: the row keeps reading_receipt, says so in words,
    // and waits for the job; the worker files the lines from its answer.
    const note = HOSTED_RECEIPT_QUEUED_WORDS;
    try {
      const db = (await platform().tenants.getDb(opts.orgId)) as unknown as RowDb;
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          ai_notes: note,
          updated_at: new Date(),
          suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'identify_failure' - 'receipt_read_failed') || ${JSON.stringify({
            reading_receipt: true,
            hosted_identify_job: { id: answer.jobId, since: new Date().toISOString(), user_id: opts.userId ?? null, receipt: true },
          })}::jsonb`,
        })
        .where("id", "=", opts.itemId)
        .execute();
      const { enqueueHostedIdentifyJob } = await import("./hosted-identify-job.js");
      await enqueueHostedIdentifyJob({ orgId: opts.orgId, itemId: opts.itemId, jobId: answer.jobId, imageFileId: opts.fileId, userId: opts.userId ?? null });
    } catch (e) {
      return failed(`could not wait for the queued read: ${(e as Error).message}`);
    }
    return { routed: false, queued: true, reason: "queued at the hosted identify", note };
  }
  if (answer.kind === "refused") {
    return failed(answer.failure ? `${answer.failure}: ${answer.message ?? ""}`.trim() : `receipt parse returned ${answer.status}`, {
      failure: answer.failure,
      ai: answer.ai,
      message: answer.message,
      keptBatchId: answer.keptBatchId,
    });
  }
  if (answer.kind === "already-in") {
    // Not a failure to read: the same receipt is in already. The photo stays
    // as it is, saying where, with "read it anyway" for a real second copy.
    const where = answer.label?.trim() ? `"${answer.label.trim()}"` : "a session";
    const lines = answer.lines > 0 ? ` (${answer.lines} line${answer.lines === 1 ? "" : "s"})` : "";
    return failed("already in the inbox", {
      failure: "already_imported",
      message: `is already in your inbox as ${where}${lines}. Read it anyway for a second copy.`,
      duplicateOf: { batch_id: answer.batch_id, label: answer.label, lines: answer.lines },
    });
  }
  if (answer.kind === "unknown") return failed(`the receipt door answered ${answer.status} in a shape this does not read`, { failure: "unknown_answer" });
  if (answer.kind === "empty") return failed("no line items on it");
  const items = answer.items;

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
