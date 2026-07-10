# @cobblr/workspace-tools

The ONE registry of workspace read/write tools an AI can call. Both AI
surfaces consume it, so they stay capability-identical by construction:

- **Ask Cobb** (in-app chat, `modules/core-ai`): read tools auto-run inside the
  agent loop under the caller's own permissions; **write tools become
  proposals** the user confirms — the chat never mutates inline.
- **MCP server** (`packages/mcp-server`): registers each tool 1:1 for an
  external Claude (Claude Code / Desktop / claude.ai connector); writes execute
  directly there, permission-checked server-side.

## Shape

A tool is `{ name, description, mode: read|write, params (zod shape),
execute(api, args) }`. Executors speak to the REST API through the
`WorkspaceApi` seam — each consumer supplies its transport (in-process fetch
with the request's Authorization vs outbound fetch with a `cbt_` token). Tools
never fetch directly and never throw on HTTP errors; they return
`{ ok, data | error }`.

`params` are zod (what the MCP SDK wants); `jsonSchemaOf()` converts a shape
to JSON schema for provider-native tool-calling (Anthropic/OpenAI wire
formats).

Create/update/delete routes come from each entity kind's manifest
declarations (`createEndpoint` / `updateEndpoint` / `deleteEndpoint`) — no
route guessing; an undeclared kind is honestly not writable this way.

## Rules

- **Adding a capability = one entry in `src/tools.ts`.** Never add a
  workspace-operating tool to a consumer directly.
- Tool descriptions are written for the MODEL (when to reach for the tool);
  consumer prompts don't duplicate them.
- Keep results prompt-sized — clamp lists, summarize kinds.
