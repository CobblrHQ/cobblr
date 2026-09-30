// The page's one way to send a file: every multipart upload in the browser
// goes through sendUpload (lint:page-uploads-through-one-door), so every
// surface says the same true sentence when one fails.
//
// Three ways an upload fails, and what each says:
//   • The api refused it (JSON error body): its own sentence, which names the
//     size and the limit ("This file is about 31 MB; ...").
//   • Something in front of the api refused it (a proxy's 413 as an HTML
//     page): the file's size and that this server does not let it through.
//   • The connection dropped before any answer (a proxy closing a body it
//     will not take, a phone losing signal). fetch rejects with a bare
//     TypeError, which Safari words as "Load failed" and Chrome as "Failed to
//     fetch": neither tells a person what happened or what to do. It says
//     CONNECTION_LOST_MESSAGE instead, and reports the drop to the server log
//     (the server never had the file, so it could not log it otherwise).

import { CONNECTION_LOST_MESSAGE, megabytes } from "@cobblr/platform-contract/upload";

export class UploadError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export interface SendUploadOptions {
  /** A bearer token; omitted, the request carries none. */
  token?: string | null;
  /** The file being sent, for the size a failure names. */
  file?: File | Blob | null;
}

/** The api path an upload was for, and the workspace it names. */
function slugOf(url: string): string | null {
  return /\/api\/v1\/orgs\/([^/?#]+)\//.exec(url)?.[1] ?? null;
}

/** Tell the server an upload's connection dropped. Best effort: a failure to
 *  report is not a second failure to show. */
function reportConnectionLost(url: string, opts: SendUploadOptions): void {
  const slug = slugOf(url);
  if (!slug) return;
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "");
  void fetch(`/api/v1/orgs/${slug}/uploads/connection-lost`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: JSON.stringify({ route: path, size_bytes: opts.file?.size ?? null, mime_type: opts.file?.type || null }),
  }).catch(() => undefined);
}

/** POST a multipart form. Resolves with the response for ANY answer (a
 *  refusal included: read it with uploadErrorOf); throws an UploadError with
 *  CONNECTION_LOST_MESSAGE when no answer came. An abort is rethrown as is. */
export async function sendUpload(url: string, form: FormData, opts: SendUploadOptions = {}, method: "POST" | "PUT" = "POST"): Promise<Response> {
  try {
    return await fetch(url, { method, headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {}, body: form });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    reportConnectionLost(url, opts);
    throw new UploadError(0, "connection_lost", CONNECTION_LOST_MESSAGE);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A refused upload's code and sentence: the api's own, or, for a proxy's
 *  page, one that names the file's size. */
export async function uploadErrorOf(res: Response, file?: File | Blob | null): Promise<{ code: string; message: string }> {
  const text = await res.text().catch(() => "");
  const body = parseJson(text) as { error?: { code?: string; message?: string } } | null;
  if (body?.error?.message) return { code: body.error.code ?? "upload_failed", message: body.error.message };
  if (res.status === 413) {
    const size = file?.size ? `This file is about ${megabytes(file.size)}, ` : "This file is ";
    return { code: "file_too_large", message: `${size}more than this server lets through in one upload.` };
  }
  return { code: "upload_failed", message: `The upload failed (${res.status}). Try again.` };
}

/** sendUpload, then a refusal thrown as an UploadError with its sentence:
 *  for a caller that only wants the answer's body. */
export async function uploadJson<T>(url: string, form: FormData, opts: SendUploadOptions = {}, method: "POST" | "PUT" = "POST"): Promise<T> {
  const res = await sendUpload(url, form, opts, method);
  if (!res.ok) {
    const e = await uploadErrorOf(res, opts.file);
    throw new UploadError(res.status, e.code, e.message);
  }
  return (await res.json()) as T;
}
