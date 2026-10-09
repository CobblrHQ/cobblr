// The hosted MCP door as an assistant meets it: a connector's OAuth sign-in
// allowed to change one workspace, and a tool call over JSON-RPC.
import { createHash, randomBytes } from "node:crypto";
import { BASE, http, type TestSession } from "./helpers.js";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** A connector token for `s`'s workspace, granted look and change. */
export async function connectorToken(s: TestSession): Promise<string> {
  const reg = (await fetch(`${BASE}/api/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  }).then((r) => r.json())) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const q = {
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "st",
    scope: "cobblr:look cobblr:change",
  };
  const approved = await http<{ redirect: string }>(s, "/api/v1/oauth/authorize", { method: "POST", body: { ...q, decision: "allow", workspace: s.slug, access: "change" } });
  const code = new URL(approved.redirect).searchParams.get("code")!;
  const tok = (await fetch(`${BASE}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }).toString(),
  }).then((r) => r.json())) as { access_token: string };
  return tok.access_token;
}

/** An action invoked over MCP, as an assistant's tool call. */
export async function invokeViaMcp(token: string, slug: string, actionId: string, entity: { kind: string; id: string } | null, args: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}/api/v1/hooks/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cobblr_invoke_action", arguments: { workspace: slug, action_id: actionId, ...(entity ? { entity_kind: entity.kind, entity_id: entity.id } : {}), args } },
    }),
  });
  const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
  return { isError: body.result?.isError === true || !!body.error, text: body.result?.content?.map((c) => c.text ?? "").join(" ") ?? body.error?.message ?? "" };
}

/** Cobb reached the action: it ran, or it asked for a person first. */
export const reached = (r: { isError: boolean; text: string }) => !r.isError || /needs a person to confirm|confirm/i.test(r.text);
