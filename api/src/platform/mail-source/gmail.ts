// Gmail as a MailSource: the four calls a read-only mailbox needs, and the
// MIME walk that turns Google's message JSON into the shape the receipt
// pipeline reads.
//
// Filtering is Google's: `list` carries the allowlist query, so the ids that
// come back are already only store and carrier mail, and nothing else is
// ever fetched. (history.list, the incremental feed, takes no query and would
// hand over every new id first; messages.list with `q` costs 5 units and
// hands over only matches.) Attachments are fetched only for a message the
// query named and only when they are a receipt shape (a PDF or an image)
// under the size cap.
//
// Plain fetch: Google's hosts are fixed constants, not a URL a person typed,
// so the SSRF guard has nothing to guard and would only fail closed under
// the hosted strict egress policy.

import { MailSourceGrantError, type MailAttachment, type MailListPage, type MailMessage, type MailSource } from "./types.js";

export const GMAIL_API_BASE = process.env.COBBLR_GMAIL_API_BASE || "https://gmail.googleapis.com";

/** A receipt-shaped attachment worth carrying into the pipeline. */
const RECEIPT_ATTACHMENT = /^(application\/pdf|image\/(?:png|jpe?g|webp|heic))/i;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Text parts past this are truncated: a store's html is big and the reader
 *  wants the order number and the state words, not the footer's third page. */
const MAX_PART_CHARS = 400_000;

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailClientOptions {
  accessToken: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Who to ask about attachments; defaults to fetching them. A test that only
   *  cares which ids were read can turn it off. */
  attachments?: boolean;
}

export class GmailSource implements MailSource {
  private readonly token: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly withAttachments: boolean;

  constructor(opts: GmailClientOptions) {
    this.token = opts.accessToken;
    this.base = (opts.apiBase ?? GMAIL_API_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.withAttachments = opts.attachments ?? true;
  }

  private async get<T>(path: string): Promise<T | null> {
    const r = await this.fetchImpl(`${this.base}/gmail/v1/users/me${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (r.status === 404) return null;
    if (r.status === 401) throw new MailSourceGrantError("access token refused");
    if (!r.ok) throw new Error(`gmail ${path.split("?")[0]}: HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  async list(query: string, pageToken?: string): Promise<MailListPage> {
    const p = new URLSearchParams({ q: query, maxResults: "100" });
    if (pageToken) p.set("pageToken", pageToken);
    const out = await this.get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`/messages?${p.toString()}`);
    return { ids: (out?.messages ?? []).map((m) => m.id), ...(out?.nextPageToken ? { nextPageToken: out.nextPageToken } : {}) };
  }

  async fetch(id: string): Promise<MailMessage | null> {
    const m = await this.get<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    if (!m) return null;
    const decoded = decodeGmailMessage(m);
    if (this.withAttachments) {
      for (const pending of decoded.pendingAttachments) {
        const a = await this.get<{ data?: string }>(`/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(pending.attachmentId)}`);
        if (a?.data) {
          decoded.message.attachments.push({
            ...(pending.filename ? { filename: pending.filename } : {}),
            ...(pending.content_type ? { content_type: pending.content_type } : {}),
            content_base64: base64UrlToBase64(a.data),
          });
        }
      }
    }
    return decoded.message;
  }

  /** The mailbox address behind the token, for the card. */
  async profile(): Promise<{ email: string } | null> {
    const p = await this.get<{ emailAddress?: string }>("/profile");
    return p?.emailAddress ? { email: p.emailAddress } : null;
  }
}

function base64UrlToBase64(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return b + "=".repeat((4 - (b.length % 4)) % 4);
}

function decodeBody(data: string | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(base64UrlToBase64(data), "base64").toString("utf8").slice(0, MAX_PART_CHARS);
  } catch {
    return "";
  }
}

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string | undefined {
  const h = (headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value;
}

/** The address inside "Amazon.com <shipment-tracking@amazon.com>". */
export function addressOf(fromHeader: string | undefined): string | undefined {
  if (!fromHeader) return undefined;
  const m = /<([^>]+)>/.exec(fromHeader);
  const raw = (m ? m[1] : fromHeader) ?? "";
  const addr = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(addr) ? addr : undefined;
}

export interface DecodedGmail {
  message: MailMessage;
  pendingAttachments: Array<{ attachmentId: string; filename?: string; content_type?: string }>;
}

/** Google's JSON to the pipeline's shape. Pure, so the MIME walk is testable
 *  on a fixture without a server: nested multiparts, an inline body in
 *  `body.data`, and attachments that arrive by id rather than inline. */
export function decodeGmailMessage(m: GmailMessage): DecodedGmail {
  const headers = m.payload?.headers;
  let text = "";
  let html = "";
  const pending: DecodedGmail["pendingAttachments"] = [];
  const inline: MailAttachment[] = [];

  const walk = (part: GmailPart | undefined): void => {
    if (!part) return;
    const mime = (part.mimeType ?? "").toLowerCase();
    const filename = part.filename || undefined;
    if (part.parts?.length) {
      for (const p of part.parts) walk(p);
      return;
    }
    if (filename && RECEIPT_ATTACHMENT.test(mime)) {
      const size = part.body?.size ?? 0;
      if (size > MAX_ATTACHMENT_BYTES) return;
      if (part.body?.attachmentId) pending.push({ attachmentId: part.body.attachmentId, filename, content_type: mime });
      else if (part.body?.data) inline.push({ filename, content_type: mime, content_base64: base64UrlToBase64(part.body.data) });
      return;
    }
    if (mime === "text/plain" && !text) text = decodeBody(part.body?.data);
    else if (mime === "text/html" && !html) html = decodeBody(part.body?.data);
  };
  walk(m.payload);

  const received = m.internalDate ? new Date(Number(m.internalDate)) : undefined;
  const from = addressOf(header(headers, "From"));
  const subject = header(headers, "Subject");
  const messageId = header(headers, "Message-ID") ?? header(headers, "Message-Id");
  return {
    message: {
      id: m.id,
      ...(from ? { from_email: from } : {}),
      ...(subject ? { subject } : {}),
      ...(messageId ? { message_id: messageId } : {}),
      ...(received && !Number.isNaN(received.getTime()) ? { received_at: received } : {}),
      ...(text ? { text } : {}),
      ...(html ? { html } : {}),
      attachments: inline,
    },
    pendingAttachments: pending,
  };
}
