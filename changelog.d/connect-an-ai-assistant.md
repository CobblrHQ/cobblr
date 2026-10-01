---
type: feature
scope: core-ai
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#API tokens (for CLI / AI / automation)
docs_published: 2026-10-01
---
New **Connect an AI assistant** page under Configuration → Connections. It gives you your workspace's MCP server URL, a button that creates a token for your assistant, and a snippet to paste into Claude Code, Claude Desktop or any other MCP client. Searching Configuration for "mcp", "claude", "chatgpt", "connector" or "ai assistant" now finds it. claude.ai and ChatGPT connectors are listed as not available yet: they sign in with OAuth, which is still being built.

## docs

**Connect an AI assistant.** Configuration → Connections → **Connect an AI
assistant** connects your own Claude to this workspace over MCP (Model Context
Protocol). The page shows the server URL for this workspace. **Create a token for
my assistant** makes a token for this workspace that expires in a year and fills it into every
snippet below it; it is shown only once, and you can revoke it under API tokens.

- **Claude Code:** copy the one-line command into a terminal, then type `/mcp`
  in Claude Code to check that cobblr is connected. It uses Claude Code's HTTP
  transport and `--scope user`, so Cobblr is there in every folder you open:

  ```
  claude mcp add --scope user --transport http cobblr "<server URL>" \
    --header "Authorization: Bearer <your token>"
  ```

  Leave out `--scope user` and Claude Code adds the server only to the folder
  you ran the command in.
- **Claude Desktop:** Settings → Developer → Edit Config, paste the snippet into
  `"mcpServers"`, and restart. It runs a small bridge with `npx`, so Node.js must
  be installed.
- **Other MCP clients:** use the server URL with the header
  `Authorization: Bearer <your token>`.

The token it makes is for this workspace only and can look and make changes:
the assistant reads and changes records and runs actions as you, never the
workspace's settings, members or connections. claude.ai, the
Claude phone apps and ChatGPT are not supported yet, because their connectors
sign in with OAuth.
