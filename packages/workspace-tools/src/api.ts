// The transport seam. Tools never fetch — they call this interface, and each
// consumer supplies its own implementation over the SAME REST surface:
//   - the in-app chat: an in-process fetch to 127.0.0.1 forwarding the
//     request's own Authorization header (the caller's permissions apply);
//   - the MCP server: an outbound fetch with the user's cbt_ API token.
// Paths are WORKSPACE-RELATIVE ("/entity-kinds", "/modules/knowledge/entries");
// the implementation prefixes /orgs/<slug>. Implementations must NOT throw on
// HTTP error statuses — tools turn a status into an honest result.

export interface WorkspaceApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface WorkspaceApi {
  request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<WorkspaceApiResponse>;
  /** An address a person can open: an org-relative API path (a picture's
   *  file) or an app page, on this workspace. Absent, or null, when the
   *  transport does not know an address the reader could use; a tool then
   *  says so rather than handing out a path that goes nowhere. */
  link?(to: { api: string } | { app: string }): string | null;
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

/** Uniform tool outcome — small, model-friendly, never a thrown string soup. */
export interface ToolResult {
  ok: boolean;
  /** Present on success. */
  data?: unknown;
  /** Present on failure — actionable, no stack traces. */
  error?: string;
}

export function toolOk(data: unknown): ToolResult {
  return { ok: true, data };
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
