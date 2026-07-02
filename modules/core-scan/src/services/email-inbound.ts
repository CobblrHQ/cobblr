// Inbound EMAIL → scan-inbox capture. The "email → the system" path: forward an
// order confirmation / shipping notice / packing list to a Cobblr inbound
// address (Cloudflare Email Routing → Worker → POST the parsed email), and its
// contents land as routed, confirm-ready items in the scan inbox — the same
// staging surface a scan or a note uses. From there each item gets identified
// and its put-away location suggested, exactly like any other capture.
//
// Registered as a core-integrations inbound handler (id "email"): a workspace
// mints an inbound token bound to it, the Worker POSTs
// { subject, from, text, html, attachments } and we act AS the workspace OWNER
// (mintSession) to run the normal capture routes — no duplicated logic.
//
// What lands where:
//   attachment (PDF / CSV / image / text) → core-files upload → /scan/receipt
//     — the tiered receipt parser (deterministic table/CSV first, AI fallback)
//     drops ONE inbox row PER LINE ITEM, so an attached invoice becomes N
//     confirm-ready parts.
//   image attachment that isn't a receipt (422) → /scan (source_kind "photo")
//     — falls back to the photo-identify path instead of being dropped.
//   multi-item BODY (≥2 quantity lines) → the same receipt parser, fed the
//     body as a text file — "1x Pico W\n2x 10k resistor" becomes two rows.
//   everything else → /scan/note (single item; location extraction +
//     matchmaker), and ALWAYS as the safety net when nothing above produced an
//     item — an email never vanishes.

import { platform } from "@cobblr/platform-contract";

// enrich.ts's INTERNAL_API — these calls carry a minted bearer, so they must
// target our own API, never a caller-influenced URL.
const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

// Abuse caps. core-files itself caps a single upload at 25 MB; we stay under it
// and bound the count so one email can't fan out into unbounded parse work.
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

interface EmailAttachment {
  filename?: string;
  content_type?: string;
  /** Raw file bytes, base64. The Cloudflare Worker reads the MIME part and
   *  base64s it; anything that can do the same works. */
  content_b64?: string;
}

interface EmailBody {
  subject?: string;
  from?: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
}

/** Strip tags + collapse whitespace from an HTML email body when no plaintext
 *  part was sent. Deliberately dumb — we only need enough text for the
 *  matchmaker to route on, not a faithful render. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The workspace's owner + slug, from the meta DB — we act as the owner so the
 *  captured item is attributed to a real member and the matchmaker menu builds
 *  against a session. Prefer `owner`; fall back to any admin, then any member. */
async function ownerOf(orgId: string): Promise<{ userId: string; slug: string } | null> {
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

// ── attachment typing ────────────────────────────────────────────────────────
// content_type from the sender is advisory; the filename extension is the
// fallback. Anything outside this set (executables, archives, calendar invites)
// is skipped — logged in the response, never parsed.
type AttachmentKind = "pdf" | "csv" | "image" | "text";

function attachmentKind(a: EmailAttachment): AttachmentKind | null {
  const ct = (a.content_type ?? "").toLowerCase();
  const name = (a.filename ?? "").toLowerCase();
  if (ct === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (ct.includes("csv") || name.endsWith(".csv")) return "csv";
  if (ct.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/.test(name)) return "image";
  if (ct.startsWith("text/") || name.endsWith(".txt")) return "text";
  return null;
}

const KIND_MIME: Record<AttachmentKind, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  image: "image/jpeg", // only used when the sender omitted content_type
  text: "text/plain",
};

// ── internal-API helpers (all as the minted owner session) ──────────────────

async function uploadFile(
  slug: string,
  token: string,
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<string | null> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  try {
    const r = await fetch(`${INTERNAL_API}/api/v1/orgs/${slug}/modules/core-files/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!r.ok) return null;
    const b = (await r.json()) as { id?: string };
    return b.id ?? null;
  } catch {
    return null;
  }
}

/** Run a stored file through /scan/receipt. Returns the created item count, or
 *  null when it wasn't parseable as a receipt (422) / the call failed. */
async function receiptCapture(slug: string, token: string, fileId: string): Promise<number | null> {
  try {
    const r = await fetch(`${INTERNAL_API}/api/v1/orgs/${slug}/modules/core-scan/scan/receipt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!r.ok) return null;
    const b = (await r.json()) as { items?: Array<{ id: string }> };
    return b.items?.length ?? 0;
  } catch {
    return null;
  }
}

/** Fallback for an image attachment that isn't a receipt: the photo-identify
 *  path (vision enrichment), so a product photo still becomes an item. */
async function photoCapture(slug: string, token: string, fileId: string): Promise<boolean> {
  try {
    const r = await fetch(`${INTERNAL_API}/api/v1/orgs/${slug}/modules/core-scan/scan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ source_kind: "photo", image_file_id: fileId }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function noteCapture(slug: string, token: string, text: string): Promise<string | null> {
  try {
    const r = await fetch(`${INTERNAL_API}/api/v1/orgs/${slug}/modules/core-scan/scan/note`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return null;
    const item = (await r.json()) as { id?: string };
    return item.id ?? null;
  } catch {
    return null;
  }
}

// ── multi-item body detection ────────────────────────────────────────────────
// ≥2 quantity-shaped lines ("1x Pico W", "2 × 10k resistor", "Qty: 3 …") means
// the body itself is an item LIST, worth splitting into one row per line via
// the receipt parser. One hit (or none) → single note, as before. Deliberately
// conservative: a false "multi" costs an AI parse + fallback, a false "single"
// just keeps today's behaviour.
export function looksMultiItem(text: string): boolean {
  const qtyLine = /^\s*\d+\s*(?:[x×]|pcs?\b|rolls?\b|units?\b)\s*\S/im;
  let hits = 0;
  for (const line of text.split(/\n|,\s+and\s+|;/)) {
    if (qtyLine.test(line) || /\bqty:?\s*\d+/i.test(line)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

export function registerEmailInbound(): void {
  platform().integrations.registerInboundHandler({
    id: "email",
    label: "Inbound email → scan inbox",
    describeWebhookConfig: () => ({}),
    emits: ["core-scan.scan.received"],
    async handle(req, ctx) {
      const b = (req.body ?? {}) as EmailBody;
      const subject = (b.subject ?? "").trim();
      const text = (b.text ?? "").trim() || (b.html ? htmlToText(b.html) : "");
      const note = [subject, text].filter(Boolean).join("\n").trim().slice(0, 4000);
      const attachments = Array.isArray(b.attachments) ? b.attachments : [];
      if (!note && attachments.length === 0) {
        return { status: 200, body: { ok: true, ignored: "empty email" } };
      }

      const who = await ownerOf(ctx.orgId);
      if (!who) return { status: 202, body: { ok: true, ignored: "no member to attribute the capture to" } };

      let token: string;
      try {
        token = await platform().auth.mintSession({ userId: who.userId });
      } catch (e) {
        return { status: 500, body: { error: `couldn't mint a capture session: ${(e as Error).message}` } };
      }

      let itemsCreated = 0;
      const skipped: string[] = [];

      // ── 1. Attachments → receipt pipeline (per-line rows) ──────────────────
      for (const a of attachments.slice(0, MAX_ATTACHMENTS)) {
        const kind = a.content_b64 ? attachmentKind(a) : null;
        if (!kind) {
          skipped.push(a.filename ?? "unnamed attachment");
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(a.content_b64!, "base64");
        } catch {
          skipped.push(a.filename ?? "undecodable attachment");
          continue;
        }
        if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
          skipped.push(`${a.filename ?? "attachment"} (size)`);
          continue;
        }
        const fileId = await uploadFile(
          who.slug,
          token,
          bytes,
          a.filename ?? `email-attachment.${kind === "image" ? "jpg" : kind}`,
          a.content_type ?? KIND_MIME[kind],
        );
        if (!fileId) {
          skipped.push(`${a.filename ?? "attachment"} (upload failed)`);
          continue;
        }
        const n = await receiptCapture(who.slug, token, fileId);
        if (n != null && n > 0) {
          itemsCreated += n;
        } else if (kind === "image" && (await photoCapture(who.slug, token, fileId))) {
          // Not a receipt — a product photo / packing-slip shot. Photo path.
          itemsCreated += 1;
        } else {
          skipped.push(`${a.filename ?? "attachment"} (unparsed)`);
        }
      }
      if (attachments.length > MAX_ATTACHMENTS) {
        skipped.push(`${attachments.length - MAX_ATTACHMENTS} attachment(s) over the ${MAX_ATTACHMENTS} cap`);
      }

      // ── 2. Multi-item body → same receipt parser, body as a text file ──────
      let bodySplit = false;
      if (note && looksMultiItem(note)) {
        const fileId = await uploadFile(who.slug, token, Buffer.from(note, "utf8"), "email-body.txt", "text/plain");
        if (fileId) {
          const n = await receiptCapture(who.slug, token, fileId);
          if (n != null && n > 0) {
            itemsCreated += n;
            bodySplit = true;
          }
        }
      }

      // ── 3. Safety net: nothing landed yet → the plain note capture ─────────
      // (Also the normal path for a simple single-item email.) When attachments
      // already produced items, a boilerplate body ("your order is attached")
      // would just be inbox noise — skip it unless nothing else landed.
      let noteItemId: string | null = null;
      if (!bodySplit && note && itemsCreated === 0) {
        noteItemId = await noteCapture(who.slug, token, note);
        if (noteItemId) itemsCreated += 1;
      }

      if (itemsCreated === 0) {
        return { status: 502, body: { error: "email received but no capture path produced an item", skipped } };
      }
      return {
        status: 200,
        body: { ok: true, items_created: itemsCreated, note_item_id: noteItemId, skipped: skipped.length ? skipped : undefined },
      };
    },
  });
}
