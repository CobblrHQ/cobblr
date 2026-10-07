// Cobb's door, for a test: connect to the hosted MCP server the way a real
// connector does (register, approve, exchange), then call its tools. A test
// that claims the coverage matrix's `cobb` dimension acts through here, so
// "the assistant can do it" means the assistant's own door did it, not a
// shortcut the assistant never takes.
import { createHash, randomBytes } from "node:crypto";
import { BASE, http, type TestSession } from "./helpers.js";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

export interface CobbDoor {
  /** Call one MCP tool; the parsed result, or what refused it. */
  call(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: unknown }>;
  /** invoke_action, as the assistant runs an action. */
  invoke(actionId: string, args: Record<string, unknown>, entity?: { kind: string; id: string }): Promise<{ isError: boolean; text: string; json: unknown }>;
}

/** Connect `s` (approving `access` on `workspace`, its own by default). */
export async function connectCobb(s: TestSession, access: "look" | "change" = "change", workspace = s.slug): Promise<CobbDoor> {
  const reg = (await fetch(`${BASE}/api/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  }).then((r) => r.json())) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const approved = await http<{ redirect: string }>(s, "/api/v1/oauth/authorize", {
    method: "POST",
    body: {
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "cobb",
      scope: access === "change" ? "cobblr:look cobblr:change" : "cobblr:look",
      decision: "allow",
      workspace,
      access,
    },
  });
  const code = new URL(approved.redirect).searchParams.get("code")!;
  const tok = (await fetch(`${BASE}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }).toString(),
  }).then((r) => r.json())) as { access_token: string };
  if (!tok.access_token) throw new Error("Cobb's door gave no token");

  const call: CobbDoor["call"] = async (tool, args) => {
    const res = await fetch(`${BASE}/api/v1/hooks/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { workspace, ...args } } }),
    });
    const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
    const text = body.result?.content?.map((c) => c.text ?? "").join("\n") ?? body.error?.message ?? "";
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* prose */
    }
    return { isError: !!body.result?.isError || !!body.error, text, json };
  };
  return {
    call,
    invoke: (actionId, args, entity) =>
      call("cobblr_invoke_action", { action_id: actionId, args, ...(entity ? { entity_kind: entity.kind, entity_id: entity.id } : {}) }),
  };
}
