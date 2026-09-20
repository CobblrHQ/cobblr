// A mail source: a person's own mailbox that Cobblr reads for store and
// carrier mail, feeding the same pipeline the forwarding address does.
//
// Gmail is the first; the shape is the seam a second one (IMAP, Outlook)
// implements. The sync (sync.ts) knows only this interface: it asks for the
// ids of matching messages since a moment, fetches the ones it has not seen,
// and hands each to ingestReceiptEmail. Nothing here reads a message the
// query did not name.

export interface MailAttachment {
  filename?: string;
  content_type?: string;
  content_base64: string;
}

/** One message, decoded to what the receipt pipeline reads. */
export interface MailMessage {
  /** The id at the source: the dedup key and the replay handle. */
  id: string;
  from_email?: string;
  subject?: string;
  message_id?: string;
  /** When the source received it. */
  received_at?: Date;
  text?: string;
  html?: string;
  attachments: MailAttachment[];
}

export interface MailListPage {
  ids: string[];
  nextPageToken?: string;
}

/** The narrowest thing a mailbox has to answer. `query` is the source's own
 *  filter language (Gmail's `from:(…) after:…`); the allowlist builds it. */
export interface MailSource {
  /** Ids of messages matching the query, newest first, one page at a time. */
  list(query: string, pageToken?: string): Promise<MailListPage>;
  /** One message, decoded. Null when the source no longer has it. */
  fetch(id: string): Promise<MailMessage | null>;
}

/** Why a sync stopped, distinguished because they want different answers:
 *  a dead grant needs the person; a transient error needs the next round. */
export class MailSourceGrantError extends Error {
  readonly kind = "grant";
  constructor(message: string) {
    super(message);
    this.name = "MailSourceGrantError";
  }
}
