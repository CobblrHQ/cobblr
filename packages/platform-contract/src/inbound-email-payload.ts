// What the Email Worker sends the app for one parsed email, in one place.
//
// The Worker (scripts/email-workers/inbound-email/worker.js) parses a message's
// MIME and POSTs { to, from_email, text, html, subject, message_id,
// attachments } to /api/v1/inbound-email. The mapping from a parsed email to
// that payload used to live inside the Worker, where nothing but production
// ran it. It is here so the staging delivery door
// (api/src/platform/email-delivery-door.ts) builds the SAME payload from a
// recorded .eml, and a test holds the two together.
//
// Plain syntax only: the Worker bundles this file, and the api runs it under
// Node's strip-only type loader.

export interface ParsedAttachment {
  filename?: string | null;
  mimeType?: string | null;
  content: ArrayBuffer | Uint8Array | string;
  contentId?: string | null;
  disposition?: string | null;
}

export interface ParsedEmail {
  text?: string | null;
  html?: string | null;
  subject?: string | null;
  messageId?: string | null;
  attachments?: ParsedAttachment[] | null;
}

export interface InboundPayloadOut {
  to: string;
  from_email: string;
  text: string;
  html: string;
  subject: string;
  message_id: string;
  attachments: Array<{ filename: string; content_type: string; content_base64: string; content_id?: string; disposition?: string }>;
}

const INGESTABLE_MIME = /^(application\/pdf|image\/|text\/csv|application\/vnd\.ms-excel|text\/plain|application\/octet-stream)/i;
const INGESTABLE_EXT = /\.(pdf|png|jpe?g|webp|heic|csv)$/i;

export function toBase64(buf: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof buf === "string" ? new TextEncoder().encode(buf) : new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000; // avoid String.fromCharCode arg-count limits on big files
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

/** The payload for one parsed email, or null when there is nothing usable in
 *  it (the Worker drops those: a reject would bounce). `to` is the envelope
 *  recipient, `from` the envelope sender. */
export function payloadFromParsedEmail(email: ParsedEmail, envelope: { to: string; from: string }): InboundPayloadOut | null {
  const attachments = (email.attachments || [])
    .filter((a) => (a.mimeType && INGESTABLE_MIME.test(a.mimeType)) || (a.filename && INGESTABLE_EXT.test(a.filename)))
    .slice(0, 20)
    .map((a) => ({
      filename: a.filename || "attachment",
      content_type: a.mimeType || "application/octet-stream",
      content_base64: toBase64(a.content),
      // Which pictures the body SHOWS: a forwarded order's product photos
      // are its lines' pictures, never receipts to read (#5719).
      ...(a.contentId ? { content_id: String(a.contentId).replace(/^<|>$/g, "") } : {}),
      ...(a.disposition ? { disposition: a.disposition } : {}),
    }));
  const text = (email.text || "").slice(0, 20000);
  const html = (email.html || "").slice(0, 200000);
  if (attachments.length === 0 && !text && !html) return null;
  return {
    to: envelope.to,
    from_email: envelope.from,
    text,
    html,
    subject: (email.subject || "").slice(0, 300),
    message_id: (email.messageId || "").slice(0, 400),
    attachments,
  };
}
