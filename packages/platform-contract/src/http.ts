import type { UploadMiddleware, UploadOptions, UploadRefusal, UploadSizeRow } from "./upload.js";

export interface RequestGuardCtx { ip: string; path: string; method: string; userId?: string }
export type RequestGuard = (
  ctx: RequestGuardCtx,
) => Promise<{ allow: boolean; retryAfterSec?: number; reason?: string }>;
/** A delivery to a global, unauthenticated webhook endpoint
 *  (/api/v1/hooks/:id). `rawBody` is the exact transmitted bytes, captured so a
 *  handler can verify a provider signature (Stripe, GitHub, …) against them.
 *  `method` is "POST" for webhooks/interactivity or "GET" for OAuth callbacks. */
export interface PublicWebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string;
  query: Record<string, unknown>;
}
export interface PublicWebhookHandler {
  /** URL segment under /api/v1/hooks/, e.g. "stripe-billing". Last
   *  registration for an id wins. */
  id: string;
  /** Return `headers` + a 3xx `status` with a `Location` header to issue a
   *  redirect (an OAuth "Add to X" callback) instead of a JSON body. */
  handle: (
    req: PublicWebhookRequest,
  ) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
}
export interface PlatformHttp {
  /** Hosted overlay registers a request guard (rate-limit / abuse). */
  registerRequestGuard(g: RequestGuard): void;
  /** Register a global, UNAUTHENTICATED webhook endpoint mounted at
   *  /api/v1/hooks/:id. For ACCOUNT-LEVEL provider webhooks (Stripe billing,
   *  GitHub app, …) that are NOT tenant-scoped — distinct from
   *  integrations.registerInboundHandler, which is the per-workspace,
   *  token-in-URL inbound receiver. The handler verifies its own signature and
   *  resolves any tenant from the payload; the platform mounts it before auth
   *  and captures rawBody for signature checks. Open core mounts the dispatch
   *  route regardless, 404-ing unregistered ids. */
  registerWebhook(h: PublicWebhookHandler): void;
  /** The one upload door (./upload): a multipart middleware for one file,
   *  streamed to a temporary file on disk and hashed as it arrives (read it
   *  with `uploadedFile(req)`), its limit by its kind unless the route sets
   *  one. A refusal (too large, too many files, the wrong field) answers
   *  413/400 with its code, the file's size and the limit, never a 500, and
   *  writes one log line of the facts. Every multer route goes through here
   *  (lint:uploads-through-one-door). */
  upload(opts: UploadOptions): UploadMiddleware;
  /** The size row a file falls in on this deployment (its design-file limit
   *  is a per-deployment setting): for a route judging files it unpacks
   *  itself, a zip's entries. */
  uploadSizeFor(filename: string, mimeType: string | null): UploadSizeRow;
  /** A route refusing an upload itself, after the door let it in (a full
   *  workspace, a type it does not take): the same log line as the door's
   *  own refusals. Never the file's name or bytes. */
  uploadRefused(req: unknown, refusal: UploadRefusal): void;
}
