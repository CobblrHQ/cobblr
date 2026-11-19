import { EDITED_FROM_HEADER, encodeEditedFrom } from "@cobblr/platform-contract/edited-from";
// The transport seam. Tools never fetch — they call this interface, and each
// consumer supplies its own implementation over the SAME REST surface:
//   - the in-app chat: an in-process fetch to 127.0.0.1 forwarding the
//     request's own Authorization header (the caller's permissions apply);
//   - the MCP server: an outbound fetch with the user's cbt_ API token.
// Paths are WORKSPACE-RELATIVE ("/entity-kinds", "/modules/knowledge/entries");
// the implementation prefixes /orgs/<slug>. Implementations must NOT throw on
// HTTP error statuses — tools turn a status into an honest result.

import { maskSecretValues } from "@cobblr/platform-contract/secret-field";

export interface WorkspaceApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface WorkspaceRequestOptions {
  /** Sent as the Idempotency-Key header: the same write sent again under it
   *  is answered as the first was and runs nothing (retry-key.ts). A
   *  transport that talks to the kernel's REST surface must send it. */
  idempotencyKey?: string;
  /** Sent as the x-cobblr-edited-from header: for the fields a change writes,
   *  what the reader last read them as, so the server refuses the change when
   *  a person has changed one since (read-memory.ts, #7925). */
  editedFrom?: Record<string, unknown>;
}

/** The headers a transport sends for a request's options: the one place
 *  they are spelled, so every transport (the hosted MCP door, the stdio
 *  server, the in-app chat) sends all of them. */
export function requestHeaders(opts: WorkspaceRequestOptions | undefined): Record<string, string> {
  return {
    // The same write sent again under it runs once (retry-key.ts).
    ...(opts?.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
    // What the reader read; a field changed since refuses the change (read-memory.ts).
    ...(opts?.editedFrom ? { [EDITED_FROM_HEADER]: encodeEditedFrom(opts.editedFrom) } : {}),
  };
}

export interface WorkspaceApi {
  request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, opts?: WorkspaceRequestOptions): Promise<WorkspaceApiResponse>;
  /** An address a person can open: an org-relative API path (a picture's
   *  file) or an app page, on this workspace. Absent, or null, when the
   *  transport does not know an address the reader could use; a tool then
   *  says so rather than handing out a path that goes nowhere. */
  link?(to: { api: string } | { app: string }): string | null;
  /** Who is reading, for as long as their reads should be remembered: one
   *  person's chat, one MCP connection, on this workspace. With it, a change
   *  is judged against what that reader last read (read-memory.ts); without
   *  it, a change goes through as sent. */
  readerScope?: string;
}

/** The one way a transport builds `link`. `apiBase` is the REST root a
 *  person's browser can reach (`https://cobblr.example.com/api/v1`, or
 *  `/api/v1` for a reader already on that origin, the in-app chat), and
 *  `appOrigin` the web app's (`https://cobblr.example.com`, or ""). Either
 *  one null means that kind of link is not known, and `link` says null. */
export function workspaceLinks(
  bases: { apiBase: string | null; appOrigin: string | null },
  slug: string,
): (to: { api: string } | { app: string }) => string | null {
  const org = encodeURIComponent(slug);
  const api = bases.apiBase === null ? null : bases.apiBase.replace(/\/+$/, "");
  const app = bases.appOrigin === null ? null : bases.appOrigin.replace(/\/+$/, "");
  return (to) =>
    "api" in to ? (api === null ? null : `${api}/orgs/${org}${to.api}`) : app === null ? null : `${app}/w/${org}${to.app}`;
}

/** A status no server sent: the transport's own "the request never got an
 *  answer" (the MCP client says 0 with a network_error body). */
export const CONNECTION_LOST_STATUS = 599;

/** The transport as every tool sees it: a request that got no HTTP answer at
 *  all is a failure with a status the tools' `status >= 400` checks catch.
 *  Before this, status 0 slipped past every one of them and a lost connection
 *  was told to the assistant as a done action (#6968). A write that lost its
 *  answer may still have happened, so it says so and never retries. */
export function honestTransport(api: WorkspaceApi): WorkspaceApi {
  return {
    ...api,
    // The call goes through exactly as the tool made it, arguments and all.
    async request(...call: Parameters<WorkspaceApi["request"]>) {
      const [method, , , opts] = call;
      const res = await api.request(...call);
      if (Number.isInteger(res.status) && res.status >= 100 && res.status < 600) return res;
      const message =
        method === "GET"
          ? "Cobblr could not be reached, so nothing was read."
          : opts?.idempotencyKey
            ? "The connection to Cobblr was lost before it answered, so it is not known yet whether this change happened. Send the same call again with the same request_id: it applies once either way."
            : "The connection to Cobblr was lost before it answered, so it is not known whether this change happened. Check before trying it again.";
      return { status: CONNECTION_LOST_STATUS, body: { error: { code: "connection_lost", message } } };
    },
  };
}

/** Uniform tool outcome — small, model-friendly, never a thrown string soup. */
export interface ToolResult {
  ok: boolean;
  /** Present on success. */
  data?: unknown;
  /** Present on failure — actionable, no stack traces. */
  error?: string;
}

export function toolOk(data: unknown): ToolResult {
  return { ok: true, data: maskSecretValues(data) };
}

export function toolFail(error: string): ToolResult {
  return { ok: false, error };
}

/** Extract a useful message from a Cobblr error body.
 *
 *  Including WHICH FIELD, when the body says so. A validation failure answers
 *  `details: [{path:["name"], message:"Required"}]`, and "Bad request body
 *  (invalid_body)" throws that away — leaving the model to guess which of the
 *  fields it sent was wrong, and the person reading the chat none the wiser.
 *  Naming the field is the difference between a retry that can work and the
 *  same call sent twice. */
export function apiErrorMessage(res: WorkspaceApiResponse, fallback: string): string {
  const err = res.body?.error as
    | { message?: string; code?: string; details?: Array<{ path?: unknown[]; message?: string }> }
    | undefined;
  if (!err?.message) return `${fallback} (status ${res.status})`;
  const fields = (Array.isArray(err.details) ? err.details : [])
    .map((d) => {
      const field = Array.isArray(d?.path) ? d.path.filter((p) => typeof p === "string").join(".") : "";
      return field ? `${field}${d?.message ? ` (${d.message.toLowerCase()})` : ""}` : "";
    })
    .filter(Boolean);
  const which = fields.length ? `: ${fields.slice(0, 4).join(", ")}` : "";
  return `${err.message}${which}${err.code ? ` (${err.code})` : ""}`;
}
