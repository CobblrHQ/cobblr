// Pure shape + trimming for the inbound-email archive — no DB, so the
// "archiving never silently loses the record of an attachment" invariant is
// unit-testable without a database.

export interface InboundAttachment {
  filename?: string;
  content_type?: string;
  content_base64: string;
}

export interface InboundPayload {
  to?: string | string[];
  from_email?: string;
  text?: string;
  html?: string;
  subject?: string;
  message_id?: string;
  attachments?: InboundAttachment[];
}

// Cap the raw bytes persisted per message so a pathological 20×40MB email can't
// bloat cobblr_meta. Receipts are tiny; this only ever trims abuse.
export const MAX_ARCHIVE_BYTES = 30 * 1024 * 1024;

/** Bound the archived bytes while ALWAYS keeping a record of every attachment.
 *  An attachment whose bytes don't fit (or that arrived empty) is kept with its
 *  metadata and empty bytes — never dropped — so the row still shows it arrived.
 *  The count of returned entries always equals the input count. */
export function trimForArchive(attachments: InboundAttachment[]): InboundAttachment[] {
  const kept: InboundAttachment[] = [];
  let total = 0;
  for (const a of attachments) {
    const size = a.content_base64?.length ?? 0;
    if (size === 0 || total + size > MAX_ARCHIVE_BYTES) {
      kept.push({ filename: a.filename, content_type: a.content_type, content_base64: "" });
      continue;
    }
    total += size;
    kept.push(a);
  }
  return kept;
}
