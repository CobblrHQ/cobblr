/** Blob persistence driver. core-files ships + falls back to a local-disk
 *  driver; the overlay registers an S3/R2 driver via platform().files. */
export interface FilesDriver {
  put(orgId: string, fileId: string, relPath: string, bytes: Uint8Array): Promise<void>;
  /** Store a file that is already on disk without reading it into memory (a
   *  link or copy on local disk, a streamed PUT to object storage). Optional:
   *  a driver without it is given the bytes through put(). */
  putFile?(orgId: string, fileId: string, relPath: string, srcPath: string): Promise<void>;
  getBytes(orgId: string, fileId: string, relPath: string): Promise<Uint8Array | null>;
  remove(orgId: string, fileId: string): Promise<void>;
  /** Local drivers return an absolute path (Express sendFile fast path);
   *  remote drivers return null and the route streams getBytes. */
  localPath(orgId: string, fileId: string, relPath: string): string | null;
  /** Remove whatever is left under a workspace once each of its files has
   *  been removed (an empty folder, a stray a crash left). Optional: a driver
   *  keyed purely by file needs nothing more. */
  removeWorkspace?(orgId: string): Promise<void>;
}

/** Platform-level (pre-workspace) auth email — verification, password reset,
 *  magic-link delivery. Open core registers no sender (dev returns the link
 *  inline; admin-reset is the fallback). A self-hoster OR the overlay registers
 *  one. */
export interface AuthEmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body. Senders deliver multipart text+html when present (the
   *  text stays the plaintext fallback). Used for richer transactional emails
   *  (e.g. the feedback "your request is live" note). */
  html?: string;
  // `notification` = a platform-level transactional note to a known user (e.g.
  // "the feedback you reported is live"). Distinct from the pre-workspace auth
  // kinds; reuses the same registered sender (the overlay's managed mailer).
  kind: "magic_link" | "verify_email" | "password_reset" | "invite" | "notification";
  /** Optional Reply-To. Used for reply-by-email (a tokenized feedback address)
   *  so a recipient's reply can be routed back inbound instead of lost. */
  replyTo?: string;
  /** Optional From override — e.g. a per-workspace `receipts+<token>@` address so
   *  a receipt reply comes FROM the very address the user emailed (DKIM-aligned to
   *  the verified sending domain). A sender that can't set From for its domain
   *  falls back to its configured From. */
  from?: string;
  /** Threading: the Message-ID of the message this replies to. Senders set
   *  In-Reply-To + References so the recipient's client threads the reply under
   *  their original. */
  inReplyTo?: string;
  references?: string;
}
export type AuthEmailSender = (msg: AuthEmailMessage) => Promise<void>;
