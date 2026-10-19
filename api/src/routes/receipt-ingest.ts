// Receipt-by-email ingest — forward a receipt to your per-workspace address and
// its line items land in that workspace's scan inbox.
//
//   POST /receipt-ingest/email        unauth; the Cloudflare Email Worker
//                                     authenticates with COBBLR_INBOUND_EMAIL_SECRET.
//   GET  /orgs/:slug/receipt-address  authed; the caller's address for this
//                                     workspace (shown on the Scan page).
//
// The inbound route resolves the target (user, workspace) from the signed token
// in the To address (receipts+<token>@…) — see receipt-email.ts. It then writes
// each attachment via the files seam and REUSES the existing core-scan receipt
// route (POST /scan/receipt) through an internal call with a minted session
// token — so all the parse/tier/fan-out logic stays in core-scan, uncoupled.

import { productName } from "../platform/product-name.js";
import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { signSession } from "../auth/jwt.js";
import { inboundSecretOk } from "../platform/inbound-secret.js";
import { landedSomething } from "../platform/inbound-dedupe.js";
import { notifyAccount } from "../platform/notifications.js";
import { emailableUrl, pointTo, NO_ADDRESS_NOTE } from "../platform/link-origin.js";
import { planBodyCapture, planEmptyRead } from "../platform/receipt-body.js";
import { classifyOrderNotice, classifyReturnEmail, classifyShipmentEmail, isAutomatedStoreSender, isForwardingVerification, isOrderConfirmation, trackingAddedReply } from "../platform/shipment-email.js";
import { outcomeStatus } from "../platform/inbound-outcome.js";
import { bestReceiptBody, isReplyToCobblr, receiptReplyHeaders } from "../platform/inbound-email-body.js";
import { ownAddressNameFor } from "../platform/own-address.js";
import { sendAuthEmail } from "../platform/hosted-seams.js";
import { namedAddress } from "@cobblr/platform-contract/address-name";
import { emailLineImages, emailPictureParts, textLineImages } from "@cobblr/platform-contract/email-line-images";
import {
  extractReceiptToken,
  mintReceiptAddress,
  receiptEmailConfigured,
  verifyReceiptToken,
} from "../platform/receipt-email.js";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";
import { findOrderPageLink, orderPageLines, withoutSignInLinks, type OrderPageSummary } from "@cobblr/platform-contract/order-page-link";

const INTERNAL_API = selfOrigin();

// Attachments worth trying to parse as a receipt. The Worker pre-filters too,
// but we re-check (defense against a misconfigured Worker).
const INGESTABLE_MIME = /^(application\/pdf|image\/|text\/csv|application\/vnd\.ms-excel|text\/plain|application\/octet-stream)/i;
const INGESTABLE_EXT = /\.(pdf|png|jpe?g|webp|heic|csv)$/i;
export function isIngestable(a: { filename?: string; content_type?: string }): boolean {
  if (a.content_type && INGESTABLE_MIME.test(a.content_type)) return true;
  if (a.filename && INGESTABLE_EXT.test(a.filename)) return true;
  return false;
}

const Attachment = z.object({
  filename: z.string().max(255).optional(),
  content_type: z.string().max(120).optional(),
  content_base64: z.string().min(1).max(40_000_000), // ~30 MB decoded ceiling
  /** The part's Content-ID and disposition: a picture the body shows is a
   *  line's photo, never a receipt to read (#5719). */
  content_id: z.string().max(500).optional(),
  disposition: z.string().max(40).optional(),
});
const IngestEmail = z.object({
  /** The receipts+<token> local-part, or the raw To header to parse it from. */
  token: z.string().max(120).optional(),
  to: z.union([z.string().max(400), z.array(z.string().max(400)).max(20)]).optional(),
  /** Sender — used only for the single-workspace bare-address fallback. */
  from_email: z.string().email().max(255).optional(),
  /** Plain-text body — a forwarded receipt EMAIL (no file attached) is captured
   *  from this so it never silently vanishes. */
  text: z.string().max(20_000).optional(),
  attachments: z.array(Attachment).max(20).default([]),
});

// ── unauth inbound (Cloudflare Email Worker → here) ─────────────────────────

export interface ReceiptEmailInput {
  /** The receipts+<token> local-part, or the raw To header to parse it from. */
  token?: string;
  to?: string | string[];
  /** Sender — used only for the single-workspace bare-address fallback. */
  from_email?: string;
  /** Plain-text body — captured as a receipt/note when no file is attached. */
  text?: string;
  /** Html body — read when the plain part is thin (store receipts are often html). */
  html?: string;
  /** Original Subject — quoted back in the reply + used for "Re: …". */
  subject?: string;
  /** Original Message-ID — reserved for threading the reply (Phase 2). */
  message_id?: string;
  attachments: Array<{ filename?: string; content_type?: string; content_base64: string; content_id?: string; disposition?: string }>;
  /** Who this is for, when the caller already knows: a message read from the
   *  person's own connected mailbox names its owner and the workspace it is
   *  routed to, and carries no receipt address to resolve. The membership
   *  check below still runs; only the address step is skipped. */
  resolved?: { userId: string; orgId: string };
  /** Which door it came through, for the outcome and the reply: a mailbox
   *  read is news the person did not send us, so it earns no reply. */
  source?: "forward" | "gmail";
}

/** Core of receipt-by-email: resolve (user, workspace) from the token/sender,
 *  write each receipt attachment via the files seam, and reuse core-scan's
 *  /scan/receipt route per file. Pure of req/res so BOTH the standalone
 *  /receipt-ingest/email route AND the /inbound-email dispatcher can call it.
 *  Never throws for a routing miss — returns a 200 { ignored, reason } so a
 *  stray email doesn't bounce. */


export async function ingestReceiptEmail(
  input: ReceiptEmailInput,
): Promise<{ status: number; body: Record<string, unknown>; orgId?: string; userId?: string }> {
  const { token, to, from_email, subject, message_id, attachments } = input;
  // A store's "View order" link signs the buyer in (#5461). It is taken out
  // here, before the body is filed, parsed or shown to a model, and goes only
  // to Purchases, sealed, once the workspace is known.
  const orderPage = findOrderPageLink(input.html, from_email);
  const text = input.text == null ? input.text : withoutSignInLinks(input.text, orderPage);
  const html = input.html == null ? input.html : withoutSignInLinks(input.html, orderPage);
  // A forwarded store receipt often has its content in html (or a full,
  // unstripped plain body). Pick whichever carries more text for body capture.
  const bodyText = bestReceiptBody(text, html);

  // The receipts flow writes FROM this address now (#5462), so a reply to one
  // of its emails, or an out-of-office answering one, arrives here. It is not
  // a receipt: filing it would make a junk inbox item, and answering it could
  // start an out-of-office loop.
  if (isReplyToCobblr({ subject, text, attachments })) {
    return { status: 200, body: { ignored: true, reason: "reply-to-cobblr" } };
  }

  // Resolve the target (user, workspace).
  let userId: string | null = null;
  let orgId: string | null = null;
  const tok = token ?? extractReceiptToken(to);
  if (input.resolved) {
    userId = input.resolved.userId;
    orgId = input.resolved.orgId;
  } else if (tok) {
    const decoded = verifyReceiptToken(tok);
    if (!decoded) return { status: 200, body: { ignored: true, reason: "bad_token" } };
    userId = decoded.userId;
    orgId = decoded.orgId;
  } else if (from_email) {
    // Bare receipts@ with no token — only safe when the sender has exactly one
    // workspace (no ambiguity). Otherwise we can't know which workspace.
    const user = await meta
      .selectFrom("users")
      .select(["id"])
      .where(sql`lower(email)`, "=", from_email.toLowerCase())
      .executeTakeFirst();
    if (user) {
      const memberships = await meta
        .selectFrom("org_memberships")
        .select(["org_id"])
        .where("user_id", "=", user.id)
        .execute();
      if (memberships.length === 1) {
        userId = user.id;
        orgId = memberships[0]!.org_id;
      } else if (memberships.length > 1) {
        return { status: 200, body: { ignored: true, reason: "ambiguous_workspace" } };
      }
    }
  }
  if (!userId || !orgId) return { status: 200, body: { ignored: true, reason: "unresolved" } };

  // Confirm the user is (still) a member of that workspace, and get its slug.
  const membership = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.slug as slug"])
    .where("m.user_id", "=", userId)
    .where("m.org_id", "=", orgId)
    .executeTakeFirst();
  if (!membership) return { status: 200, body: { ignored: true, reason: "not_a_member" } };

  const slug = membership.slug;

  // A mail provider asking whether this address may receive forwarded mail.
  // Gmail sends the confirmation link HERE, to the receipt address, where no
  // person reads — so the one email that activates a zero-click forwarding
  // rule is exactly the one that never reaches the person setting it up.
  // Relay it to their own inbox, verbatim, and stop: it is not a receipt.
  const verification = isForwardingVerification({ subject, text, from_email });
  if (verification) {
    await notifyAccount({
      originChannel: "email",
      userId,
      representativeOrgId: orgId,
      notificationType: "core-scan.email.forwarding_verification",
      message: `Your mail provider wants you to confirm forwarding to ${productName()}. Its confirmation email is in your own inbox now — open it and click the link.`,
      link_url: `/w/${slug}/configuration/integrations`,
      email: {
        subject: `Action needed: confirm forwarding to ${productName()}${subject ? ` (${subject.slice(0, 80)})` : ""}`,
        text:
          `Your mail provider sent this to your ${productName()} receipt address to confirm it may forward mail there. ` +
          "Click the confirmation link or use the code below, and the forwarding rule turns on.\n\n" +
          "----- forwarded verbatim -----\n" +
          bodyText.slice(0, 6000),
      },
    }).catch(() => {});
    return { status: 200, body: { relayed: "forwarding_verification", provider: verification.provider, workspace: slug }, orgId, userId };
  }

  // Idempotency: the SAME email delivered twice (a provider retry / double-send
  // — identical Message-ID) must not re-import + re-notify. A genuine re-FORWARD
  // carries a NEW Message-ID, so it stays a distinct action (one input, one
  // output). We key on a PRIOR archive row for this Message-ID that already
  // landed something (items OR a saved note); the current in-flight row has no
  // outcome yet so it's excluded, and operator reprocess only targets
  // zero-outcome rows so it's never blocked either.
  const msgId = (message_id ?? "").trim();
  if (msgId) {
    const priorSuccess = await meta
      .selectFrom("inbound_emails")
      .select(["id"])
      .where("message_id", "=", msgId)
      .where("processed_at", "is not", null)
      .where(landedSomething())
      .limit(1)
      .executeTakeFirst();
    if (priorSuccess) {
      return {
        status: 200,
        body: { duplicate: true, reason: "already_processed", workspace: slug, item_count: 0 },
        orgId,
        userId,
      };
    }
  }

  // link_url is stored RELATIVE (the in-app bell routes it with React Router,
  // which takes a PATH; an absolute URL matches no route and dumps you on the
  // dashboard — reported 2026-08-01). Outbound channels absolutize it themselves.
  // The absolute form is still what goes in email/DM BODY text.
  const scanPath = `/w/${slug}/scan`;
  const scanUrl = emailableUrl(scanPath);
  const sessionToken = await signSession(userId);
  const post = (path: string, payload: Record<string, unknown>) =>
    apiFetch(`${INTERNAL_API}/api/v1/orgs/${slug}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  const results: Array<Record<string, unknown>> = [];
  // An order confirmation is an online order: its order is on its way, not
  // in hand, even before any shipping notice (#5351).
  const orderConfirmation = isOrderConfirmation((subject ?? "").replace(/^(?:fwd?|fw|re):\s*/i, "").trim());
  // parsedCount = real receipt LINE ITEMS (attachments + body parse). noteCreated
  // = the never-vanish single-note fallback fired (the receipt couldn't be parsed
  // into lines — e.g. no AI). Kept apart so the reply doesn't call a whole receipt
  // saved as one note "1 item".
  let parsedCount = 0;
  let noteCreated = false;
  /** Why the body parse failed, when it did. Null means it was never tried or
   *  it succeeded. Feeds the outcome `status` below. */
  let bodyFailure: "ai_unavailable" | "no_line_items" | "unreadable" | null = null;
  // Set when the receipt route reports this receipt is already imported (same
  // vendor + order #). Carries the file so the notification can offer a
  // one-click "import anyway" (re-runs the route with force).
  let duplicate: { fileId: string; order_ref: string | null; vendor: string | null; item_count: number } | null = null;

  // The store's own order page, when its email carried one (#5461): kept
  // sealed on the order so its lines' tracking keeps itself current, and read
  // NOW when this instance reads pages, so the receipt below is filled from
  // the page's own words (the order's name, every line) with no model asked.
  // The order may not exist yet; Purchases holds the link on the order's
  // number, which the page itself names.
  let pageSummary: OrderPageSummary | null = null;
  if (orderPage) {
    try {
      const noticeRef = classifyOrderNotice({ subject, text: bodyText.trim(), html, from_email })?.orderRef;
      const r = await post(`/modules/purchases/order-pages`, {
        link: orderPage.url,
        order_number: noticeRef ?? /#\s?([A-Z0-9][A-Z0-9-]{2,})\b/i.exec(subject ?? "")?.[1] ?? null,
        read_now: true,
      });
      const rb = (await r.json().catch(() => ({}))) as { order?: OrderPageSummary | null };
      pageSummary = r.ok ? (rb.order ?? null) : null;
      results.push({ source: "order-page", ok: r.ok, store: orderPage.host, ...(pageSummary ? { read: pageSummary.outcome, lines: orderPageLines(pageSummary).length } : {}) });
    } catch (err) {
      results.push({ source: "order-page", error: "exception", message: (err as Error).name });
    }
  }
  const pageHasLines = !!pageSummary && orderPageLines(pageSummary).length > 0;
  const withPage = pageHasLines ? { order_page: pageSummary } : {};

  // 0. The pictures the email SHOWS (the store's product photos, inline or
  //    named by "cid:"), stored as the lines' photos and never read as
  //    receipts (#5719): a forwarded order's photos were each sent to the
  //    receipt reader, failed, and no line got its own picture.
  const pictures = emailPictureParts(attachments, { html, text });
  const inline: Record<string, string> = {};
  const pictureRefs: string[] = [];
  for (const p of pictures) {
    const a = attachments[p.index]!;
    try {
      const written = await platform().files.write(orgId, new Uint8Array(Buffer.from(a.content_base64, "base64")), {
        filename: a.filename,
        mimeType: a.content_type,
      });
      if (!written) continue;
      pictureRefs.push(`file:${written.fileId}`);
      if (p.cid) inline[p.cid] = `file:${written.fileId}`;
    } catch {
      /* a picture that cannot be stored costs its line the photo, never the read */
    }
  }
  const pictureAt = new Set(pictures.map((p) => p.index));

  // 1. File attachments → core-files → core-scan's receipt parser (one row per
  //    line item). Written via the server-side seam (system capture, not a user
  //    upload).
  for (const a of attachments.filter((x, i) => !pictureAt.has(i) && isIngestable(x))) {
    try {
      const bytes = Buffer.from(a.content_base64, "base64");
      const written = await platform().files.write(orgId, new Uint8Array(bytes), {
        filename: a.filename,
        mimeType: a.content_type,
      });
      if (!written) {
        results.push({ filename: a.filename ?? null, error: "store_failed" });
        continue;
      }
      const r = await post(`/modules/core-scan/scan/receipt`, { file_id: written.fileId, origin: "email", ...(from_email ? { from: from_email } : {}), ...(orderConfirmation ? { order_confirmation: true } : {}), ...withPage });
      const body = (await r.json().catch(() => ({}))) as {
        receipt?: { item_count?: number; method?: string; vendor?: string | null };
        duplicate?: boolean;
        existing?: { order_ref?: string | null; vendor?: string | null; item_count?: number };
        error?: { code?: string; message?: string };
      };
      if (r.ok && body.duplicate) {
        duplicate = {
          fileId: written.fileId,
          order_ref: body.existing?.order_ref ?? null,
          vendor: body.existing?.vendor ?? null,
          item_count: body.existing?.item_count ?? 0,
        };
        results.push({ filename: a.filename ?? null, duplicate: true, existing: body.existing ?? null });
        continue;
      }
      if (r.ok) parsedCount += body.receipt?.item_count ?? 0;
      results.push(
        r.ok
          ? { filename: a.filename ?? null, ok: true, item_count: body.receipt?.item_count ?? 0, method: body.receipt?.method ?? null, vendor: body.receipt?.vendor ?? null }
          : { filename: a.filename ?? null, error: body.error?.code ?? `http_${r.status}`, message: body.error?.message },
      );
    } catch (err) {
      results.push({ filename: a.filename ?? null, error: "exception", message: (err as Error).message });
    }
  }

  // 2. NEVER-VANISH body fallback: a forwarded receipt EMAIL (no file attached)
  //    carries its line items in the body. When the attachments produced nothing,
  //    run the body through the RECEIPT PARSER (its AI tier extracts one row per
  //    line item from any receipt-shaped text — a forwarded order confirmation
  //    included). Only if the parser finds nothing do we capture a single NOTE, so
  //    the email always lands SOMETHING and a real multi-line receipt is never
  //    flattened into one useless item.
  const body = bodyText.trim();

  // A SHIPPING NOTIFICATION is a carrier event, not a receipt. Amazon's carry
  // no line items any more — a status line, the order number, a button — so
  // the parser would either save them as a useless note or, on a "Shipped:"
  // that still lists items, re-import the order. Read the status the email
  // announces and apply it to the parcel instead (core-scan's shipment-event
  // route finds the order, or opens an awaiting session for one it has not
  // seen). The parcel moves, the owner gets the card, nobody clicked.
  let shipment: Record<string, unknown> | null = null;
  // A RETURN is the reverse: requested, dropped off, received, refunded. It
  // goes to the order it came from (purchases' own door), or to the person as
  // a card when no order matches. Read before shipments, because "return
  // received" must never be mistaken for a parcel arriving.
  const returned = parsedCount === 0 ? classifyReturnEmail({ subject, text: body, html, from_email }) : null;
  if (returned) {
    try {
      const r = await post(`/modules/core-scan/scan/receipt/return-event`, {
        stage: returned.stage,
        vendor: returned.vendor,
        order_ref: returned.orderRef,
        item: returned.item,
        refund_amount: returned.refundAmount,
        description: returned.description,
      });
      const rb = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      shipment = { ...rb, kind: "return", http: r.status };
      results.push({ source: "return-event", ...rb });
    } catch (err) {
      results.push({ source: "return-event", error: "exception", message: (err as Error).message });
    }
  }
  const observed = parsedCount === 0 && !returned ? classifyShipmentEmail({ subject, text: body, html, from_email }) : null;
  if (observed) {
    try {
      const r = await post(`/modules/core-scan/scan/receipt/shipment-event`, {
        state: observed.state,
        vendor: observed.vendor,
        order_ref: observed.orderRef,
        tracking_number: observed.trackingNumber,
        description: observed.description,
        expected_arrival: observed.expectedArrival,
        expected_arrival_date: observed.expectedArrivalDate,
        items: observed.items,
      });
      const rb = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      shipment = { ...rb, http: r.status };
      results.push({ source: "shipment-event", ...rb });
    } catch (err) {
      results.push({ source: "shipment-event", error: "exception", message: (err as Error).message });
    }
  }
  let appliedShipment = Boolean(shipment && shipment.applied === true);
  const orderNotice = classifyOrderNotice({ subject, text: body, html, from_email });

  // A store's or carrier's MACHINE sent something this file could not read —
  // a promotion, a survey, "free music with your order". A mail rule forwards
  // those too, and the never-vanish fallback would file each as an inbox note.
  // Those notes are noise nobody asked for, so the sender decides: a machine's
  // unreadable email is archived and dropped, a person's is kept as before.
  // An email whose store page named its lines is an order, whatever its
  // body looks like: it is read, never dropped as noise or kept as a note.
  const machineNoise = parsedCount === 0 && !appliedShipment && !returned && !orderNotice && !pageHasLines && isAutomatedStoreSender(from_email);
  if (parsedCount === 0 && !appliedShipment && !machineNoise && (pageHasLines || planBodyCapture(body) === "receipt")) {
    try {
      const written = await platform().files.write(orgId, new TextEncoder().encode(body), {
        filename: "emailed-receipt.txt",
        mimeType: "text/plain",
      });
      if (written) {
        // The photo printed beside each line, which the text has lost: each
        // line's own picture, ahead of any web search (#5350).
        const fromHtml = emailLineImages(html, inline);
        const lineImages = fromHtml.length ? fromHtml : textLineImages(text, pictureRefs);
        const r = await post(`/modules/core-scan/scan/receipt`, {
          file_id: written.fileId,
          origin: "email",
          ...(from_email ? { from: from_email } : {}),
          ...(orderConfirmation ? { order_confirmation: true } : {}),
          ...withPage,
          ...(lineImages.length ? { line_images: lineImages } : {}),
        });
        const rb = (await r.json().catch(() => ({}))) as {
          receipt?: { item_count?: number };
          duplicate?: boolean;
          existing?: { order_ref?: string | null; vendor?: string | null; item_count?: number };
          error?: { failure?: "ai_unavailable" | "no_line_items" | "unreadable" };
        };
        if (r.ok && rb.duplicate) {
          duplicate = {
            fileId: written.fileId,
            order_ref: rb.existing?.order_ref ?? null,
            vendor: rb.existing?.vendor ?? null,
            item_count: rb.existing?.item_count ?? 0,
          };
          results.push({ source: "body", duplicate: true, existing: rb.existing ?? null });
        } else if (r.ok) {
          parsedCount += rb.receipt?.item_count ?? 0;
          results.push({ source: "body", ok: true, item_count: rb.receipt?.item_count ?? 0 });
        } else {
          // A non-ok parse used to be dropped on the floor, which is how the
          // work-list ended up unable to tell "no AI configured, try again
          // later" from "there was no receipt in this email". Keep the reason.
          bodyFailure = rb.error?.failure ?? "no_line_items";
          results.push({ source: "body", ok: false, failure: bodyFailure });
        }
      }
    } catch (err) {
      results.push({ source: "body", error: "exception", message: (err as Error).message });
    }
  }
  // The parser took nothing. Decided OUTSIDE the body-length branch above,
  // because an Amazon "Ordered: 1 Electronics item" has a body too short to
  // parse and still names the order the shipping notices need (planEmptyRead).
  const empty = planEmptyRead({
    text: body,
    parsedCount,
    duplicate: Boolean(duplicate),
    appliedShipment,
    orderNotice: Boolean(orderNotice && orderNotice.vendor && orderNotice.orderRef),
    machineNoise,
  });
  if (empty === "order-notice" && orderNotice) {
    // Open it as an awaiting session (state "ordered": no carrier state, just
    // the parcel and its promised day). Never a note, which would be a receipt
    // for nothing with the order number buried in it.
    try {
      const r = await post(`/modules/core-scan/scan/receipt/shipment-event`, {
        state: "ordered",
        vendor: orderNotice.vendor,
        order_ref: orderNotice.orderRef,
        description: (subject ?? "").slice(0, 200) || null,
        expected_arrival_date: orderNotice.expectedArrivalDate,
      });
      const rb = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      shipment = { ...rb, kind: "order", http: r.status };
      appliedShipment = rb.applied === true;
      results.push({ source: "order-notice", ...rb });
    } catch (err) {
      results.push({ source: "order-notice", error: "exception", message: (err as Error).message });
    }
  } else if (empty === "note") {
    // The parser found nothing usable (e.g. a real receipt but no AI to split it)
    // — capture the whole body as one note item so it never silently disappears.
    const r = await post(`/modules/core-scan/scan/note`, { text: body.slice(0, 2000) });
    if (r.ok) {
      noteCreated = true;
      results.push({ source: "body-note", ok: true });
    }
  }

  // 3. Reply to the sender about THEIR email — BRIEF, and honest about what
  //    actually happened. The reply is a one-way, threaded notification built by
  //    receiptReplyHeaders: FROM the person's own receipts address, named
  //    "Cobblr Receipts" so Gmail learns the name (#5462), NO Reply-To; a reply
  //    to it is dropped above by isReplyToCobblr, never filed as junk. Three cases, so a whole receipt saved as ONE note is never
  //    miscounted as "1 item":
  //      parsedCount > 0 → the accurate line-item count
  //      duplicate       → already imported (same vendor + order #); offer
  //                        "import anyway" rather than silently duplicating
  //      noteCreated     → saved as one note (couldn't split into line items)
  //      neither         → "couldn't find a receipt"
  //    Goes to the resolved account (in-app + their registered email), never the
  //    raw sender, so no backscatter.
  const subj = (subject ?? "").trim();
  const reSubject = (base: string) => (subj ? `Re: ${subj}` : base);
  const replyHeaders = receiptReplyHeaders(mintReceiptAddress(userId, orgId), message_id, await ownAddressNameFor(userId, orgId, "receipts"));
  // A message READ from the person's own mailbox was never sent to us, so
  // there is nobody to answer: "we could not find a receipt in your email"
  // would be a reply to a store. What landed is still worth the bell (a
  // receipt imported), on that channel alone; a duplicate or a miss is not.
  const readFromMailbox = input.source === "gmail";

  // A parcel a notice added to an order already imported is answered with
  // what was added (#5351): which order, which lines, which number, which
  // day. Before, the notice matched no order, the parser read its order
  // number and the reply was "you already imported this receipt", with the
  // tracking number dropped. A notice that is ALSO the moment (delivered, out
  // for delivery) is answered by the parcel's own card instead.
  const parcel = (shipment?.parcel ?? null) as Parameters<typeof trackingAddedReply>[0] & { added?: boolean } | null;
  const parcelIsNews = Boolean(appliedShipment && parcel?.added && observed && observed.state !== "delivered" && observed.state !== "out_for_delivery");

  if (parcelIsNews && parcel) {
    const said = trackingAddedReply(parcel);
    await notifyAccount({
      originChannel: readFromMailbox ? "in_app" : "email",
      userId,
      representativeOrgId: orgId,
      notificationType: "core-scan.email.tracking_added",
      message: said,
      link_url: scanPath,
      email: {
        subject: reSubject("Tracking added to your order"),
        text: said,
        ...replyHeaders,
      },
    }).catch(() => {});
  } else if (appliedShipment || machineNoise || (readFromMailbox && parsedCount === 0 && !noteCreated)) {
    // The parcel's own notification (the sweep's card, to the parcel's owner)
    // is the answer. A "we got your email" on top of it is the double-send
    // this file has already been cured of once (2026-08-24). And a store's
    // promotion earns no reply at all: nobody wrote to us.
  } else if (parsedCount > 0) {
    await notifyAccount({
      // An emailed receipt is answered by email - the bell records it, Discord
      // stays quiet. The double-send this ends was reported 2026-08-24.
      originChannel: readFromMailbox ? "in_app" : "email",
      userId,
      representativeOrgId: orgId,
      notificationType: "core-scan.email.imported",
      message: `Imported ${parsedCount} item${parsedCount === 1 ? "" : "s"} from your emailed receipt${subj ? ` "${subj}"` : ""} into your scan inbox.`,
      link_url: scanPath,
      email: {
        subject: reSubject("Your emailed receipt is in your scan inbox"),
        text: `We captured ${parsedCount} item${parsedCount === 1 ? "" : "s"} from your receipt. ${pointTo("Review them in your scan inbox", scanUrl)}`,
        ...replyHeaders,
      },
    }).catch(() => {});
  } else if (duplicate && observed?.trackingNumber) {
    // A shipping notice that still found no order, and whose order number
    // the parser knew: it is not a second copy of the receipt, and saying so
    // would hide the one thing it carried. Say what it was, and where the
    // number goes.
    const refLabel = duplicate.order_ref ? ` (order #${duplicate.order_ref})` : "";
    await notifyAccount({
      originChannel: readFromMailbox ? "in_app" : "email",
      userId,
      representativeOrgId: orgId,
      notificationType: "core-scan.email.shipment_unmatched",
      message: `That was a shipping notice${refLabel} with tracking number ${observed.trackingNumber}, but I couldn't tell which order to add it to. Open the order and add the number there.`,
      link_url: `/w/${slug}/purchases`,
      email: {
        subject: reSubject("Tracking number not added"),
        text: `That was a shipping notice${refLabel} with tracking number ${observed.trackingNumber}, but I couldn't tell which order to add it to. ${pointTo("Open the order in Purchases and add the number there", emailableUrl(`/w/${slug}/purchases`))}`,
        ...replyHeaders,
      },
    }).catch(() => {});
  } else if (duplicate) {
    const refLabel = duplicate.order_ref ? ` (order #${duplicate.order_ref})` : "";
    const fromLabel = duplicate.vendor ? ` from ${duplicate.vendor}` : "";
    const n = duplicate.item_count;
    // Deep link that re-runs the import with force for THIS file if the user
    // really wants the duplicate; the scan page confirms before importing.
    const reimportPath = `/w/${slug}/scan?reimport_file=${duplicate.fileId}${duplicate.order_ref ? `&ref=${encodeURIComponent(duplicate.order_ref)}` : ""}`;
    const reimportUrl = emailableUrl(reimportPath);
    await notifyAccount({
      // An emailed receipt is answered by email - the bell records it, Discord
      // stays quiet. The double-send this ends was reported 2026-08-24.
      originChannel: "email",
      userId,
      representativeOrgId: orgId,
      notificationType: "core-scan.email.duplicate",
      message: `You already imported this receipt${refLabel}${fromLabel} — its ${n} item${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} already in your scan inbox. Open it there, or import this copy anyway.`,
      link_url: reimportPath,
      email: {
        subject: reSubject("You already imported this receipt"),
        text: `Looks like you already imported this receipt${refLabel}. Its items are already in your scan inbox.${reimportUrl ? ` To import this copy anyway:\n${reimportUrl}` : ` ${NO_ADDRESS_NOTE}`}`,
        ...replyHeaders,
      },
    }).catch(() => {});
  } else if (noteCreated) {
    await notifyAccount({
      // An emailed receipt is answered by email - the bell records it, Discord
      // stays quiet. The double-send this ends was reported 2026-08-24.
      originChannel: readFromMailbox ? "in_app" : "email",
      userId,
      representativeOrgId: orgId,
      notificationType: "core-scan.email.received",
      message: `Saved your emailed receipt${subj ? ` "${subj}"` : ""} to your scan inbox — I couldn't split it into line items, so it's there as one note to sort.`,
      link_url: scanPath,
      email: {
        subject: reSubject("Your receipt is in your scan inbox (as a note)"),
        text: `We saved your receipt to your scan inbox. We couldn't split it into line items automatically, so it's ${pointTo("there as a single note for you to sort", scanUrl)}`,
        ...replyHeaders,
      },
    }).catch(() => {});
  } else {
    await notifyAccount({
      // An emailed receipt is answered by email - the bell records it, Discord
      // stays quiet. The double-send this ends was reported 2026-08-24.
      originChannel: "email",
      userId,
      representativeOrgId: orgId,
      notificationType: "core-scan.email.no_receipt",
      message: "We got your email but couldn't find a receipt to import. Reply with the receipt as a PDF or photo, or forward the store's receipt email.",
      link_url: scanPath,
      email: {
        subject: reSubject("We couldn't find a receipt in your email"),
        text: `We got your email but couldn't find a receipt to import. Reply with the receipt as a PDF or photo, or forward the store's receipt email${scanUrl ? `:\n${scanUrl}` : `. ${NO_ADDRESS_NOTE}`}`,
        ...replyHeaders,
      },
    }).catch(() => {});
  }

  return {
    status: 200,
    body: {
      workspace: slug,
      item_count: parsedCount,
      note: noteCreated,
      shipment: appliedShipment ? shipment : null,
      machine_noise: machineNoise,
      duplicate: !!duplicate,
      status: outcomeStatus({ parsedCount, duplicate: !!duplicate, bodyFailure, shipment: appliedShipment }),
      results,
    },
    orgId,
    userId,
  };
}

export const receiptInboundRouter = Router();

receiptInboundRouter.post("/receipt-ingest/email", async (req, res, next) => {
  try {
    if (!inboundSecretOk(req.headers["x-inbound-secret"])) {
      res.status(401).json({ error: { code: "unauthorized", message: "Bad inbound secret." } });
      return;
    }
    const parsed = IngestEmail.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad payload", details: parsed.error.issues } });
      return;
    }
    const out = await ingestReceiptEmail(parsed.data);
    res.status(out.status).json(out.body);
  } catch (err) {
    next(err);
  }
});

// ── authed: the caller's forwarding address for a workspace ─────────────────

export const receiptAddressRouter = Router({ mergeParams: true });

receiptAddressRouter.get("/:slug/receipt-address", requireAuth, withTenant, async (req, res) => {
  const userId = (req as unknown as { session?: { id: string } }).session?.id;
  const orgId = (req as unknown as { tenant?: { org: { id: string } } }).tenant?.org.id;
  if (!userId || !orgId) {
    res.status(401).json({ error: { code: "no_auth", message: "Auth required." } });
    return;
  }
  const address = mintReceiptAddress(userId, orgId);
  // The names these addresses send as (#5462), so the card's "Add to
  // contacts" and the person's mail client agree on what to call them.
  const [receipt_name, order_name] = await Promise.all([ownAddressNameFor(userId, orgId, "receipts"), ownAddressNameFor(userId, orgId, "orders")]);
  res.json({ configured: receiptEmailConfigured(), address, order_address: address?.replace(/^receipts\+/, "orders+") ?? null, receipt_name, order_name });
});

const EmailMeBody = z.object({ which: z.enum(["receipts", "orders"]).default("receipts") });

// UI-SCREEN: /scan
// AI-REACH: exempt — it mails the person their own address, from that address, so their mail client learns its name; the assistant can already say the address (GET receipt-address), and mailing someone is their own press.
receiptAddressRouter.post("/:slug/receipt-address/email-me", requireAuth, withTenant, async (req, res, next) => {
  // ROLE: any member (it mails the caller their own address, from it; nothing in the workspace changes)
  try {
    const userId = (req as unknown as { session?: { id: string } }).session?.id;
    const orgId = (req as unknown as { tenant?: { org: { id: string; name?: string } } }).tenant?.org.id;
    if (!userId || !orgId) {
      res.status(401).json({ error: { code: "no_auth", message: "Auth required." } });
      return;
    }
    const parsed = EmailMeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "which is receipts or orders." } });
      return;
    }
    const receipts = mintReceiptAddress(userId, orgId);
    if (!receipts) {
      res.status(409).json({ error: { code: "not_configured", message: `This ${productName()} has no email address set up for receipts.` } });
      return;
    }
    const which = parsed.data.which;
    const address = which === "orders" ? receipts.replace(/^receipts\+/, "orders+") : receipts;
    const name = await ownAddressNameFor(userId, orgId, which);
    const user = await meta.selectFrom("users").select("email").where("id", "=", userId).executeTakeFirst();
    if (!user?.email) {
      res.status(409).json({ error: { code: "no_email", message: "Your account has no email address to send it to." } });
      return;
    }
    const text = which === "orders"
      ? `This is your ${name} address: ${address}\n\nForward the emails your customers send with an order here, and each becomes a draft order for you to check. Save this sender as a contact, and typing "${productName()}" in your To field finds it.`
      : `This is your ${name} address: ${address}\n\nForward receipts and order emails here, and their lines become items in ${productName()}. Save this sender as a contact, and typing "${productName()}" in your To field finds it.`;
    const sent = await sendAuthEmail({ to: user.email, subject: `Your ${name} address`, text, kind: "notification", from: namedAddress(name, address) });
    if (!sent) {
      res.status(503).json({ error: { code: "not_sent", message: `This ${productName()} could not send email just now. Copy the address instead.` } });
      return;
    }
    res.json({ sent: true, to: user.email, name });
  } catch (err) {
    next(err);
  }
});
