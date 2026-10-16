import { withArticle } from "@cobblr/platform-contract/plural";
import { productName } from "@cobblr/platform-web";
// What "Connect an AI assistant" tells a person to paste, per client. Pure so a
// test can hold the claims: every snippet names this deployment's endpoint and
// the workspace, and a client is only ever offered as working when the
// endpoint can serve it. claude.ai's connectors sign in with OAuth: offered
// when this deployment says it can take that sign-in (GET /oauth/status),
// with the URL alone and no token, since the sign-in makes one. ChatGPT's are
// listed as not yet available rather than given steps that would fail.

/** The hosted MCP endpoint (api/src/platform/hosted-mcp.ts), bound to one
 *  workspace so every tool call defaults to it. */
export function mcpEndpoint(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/hooks/mcp?workspace=${encodeURIComponent(slug)}`;
}

export type AssistantClient = {
  id: string;
  label: string;
  /** "ready": the steps work today. "not-yet": listed so nobody hunts for it,
   *  with the reason instead of steps. */
  status: "ready" | "not-yet";
  where: string;
  steps: string[];
  snippet?: string;
};

export const TOKEN_PLACEHOLDER = "cbt_YOUR_TOKEN";

/** What this deployment says about signing in from a connector. */
export type ConnectorSignIn = { available: boolean; url: string } | null;

export function assistantClients(endpoint: string, token: string | null, signIn: ConnectorSignIn = null): AssistantClient[] {
  const t = token ?? TOKEN_PLACEHOLDER;
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      status: "ready",
      where: "In a terminal",
      steps: [
        `Run this once in a terminal. --scope user makes ${productName()} available in every folder you open Claude Code in; without it, it is only added to the folder you ran it from.`,
        "In Claude Code, type /mcp to check that cobblr shows as connected.",
      ],
      snippet: `claude mcp add --scope user --transport http cobblr "${endpoint}" --header "Authorization: Bearer ${t}"`,
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      status: "ready",
      where: "Settings → Developer → Edit Config",
      steps: [
        "Add this inside \"mcpServers\" in the file that opens, then restart Claude Desktop.",
        "It runs a small bridge with npx, so Node.js needs to be installed.",
      ],
      snippet: JSON.stringify(
        { cobblr: { command: "npx", args: ["-y", "mcp-remote", endpoint, "--header", `Authorization:Bearer ${t}`] } },
        null,
        2,
      ),
    },
    {
      id: "other",
      label: "Other MCP clients",
      status: "ready",
      where: "Any client that can add a remote (HTTP) MCP server with a header",
      steps: ["Server URL and header:"],
      snippet: `URL:    ${endpoint}\nHeader: Authorization: Bearer ${t}`,
    },
    signIn?.available
      ? {
          id: "claude-ai",
          label: "claude.ai and the Claude phone apps",
          status: "ready",
          where: "claude.ai: Settings → Connectors → Add custom connector",
          steps: [
            `Add a custom connector named ${productName()} with this URL. There is no token to paste: Connect opens ${withArticle(productName())} sign-in, where you choose the one workspace it may use and whether it may only look or also make changes.`,
            "The Claude phone apps use the connectors on your account, so it shows there too. Once approved it is listed under Connected apps below, and Disconnect there ends it.",
          ],
          snippet: signIn.url,
        }
      : {
          id: "claude-ai",
          label: "claude.ai and the Claude phone apps",
          status: "not-yet",
          where: "Settings → Connectors",
          steps: [
            signIn
              ? "Not on this server: a try-it sandbox has no account for a connector to sign in to."
              : "Not available yet. Connectors there sign in with OAuth, and this server does not take that sign-in.",
          ],
        },
    {
      id: "chatgpt",
      label: "ChatGPT",
      status: "not-yet",
      where: "Settings → Connectors",
      steps: ["Not available yet: ChatGPT's connectors are not supported."],
    },
  ];
}
