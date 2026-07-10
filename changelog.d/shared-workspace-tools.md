---
type: feature
scope: mcp-server
date: 2026-07-10
docs_target: docs/modules/mcp-server.md#Tools (each maps to one REST endpoint)
docs_published: 2026-07-10
---
**Your external Claude can now fully read AND write your workspace.** The MCP server gains `cobblr_create_record`, `cobblr_update_record`, `cobblr_delete_record`, and `cobblr_search_records` (cross-kind search) alongside the existing reads and actions, so a Claude Desktop / claude.ai connector can save a knowledge entry, fix a record's fields, or clean one up, not just look around. Under the hood these come from a new shared tool registry (`@cobblr/workspace-tools`) that the in-app Ask Cobb chat is being wired to as well, so the two AI surfaces stay capability-identical by construction. What's writable is honest by design: a record kind is creatable/updatable/deletable only where its module declares the route, no guessed endpoints, no surprise 404s.

## docs

Driving Cobblr from **your own Claude** (Claude Code / Desktop / a claude.ai connector via the MCP server) can now fully read AND write your workspace records:

- **Read**: `cobblr_list_record_kinds` (every kind you hold, with each one's fields and whether it can be created/updated/deleted), `cobblr_list_records` (one kind, with text filter), `cobblr_get_record`, and the new `cobblr_search_records`: cross-kind text search when you don't know where something lives.
- **Write**: the new `cobblr_create_record`, `cobblr_update_record` (partial: only the fields you pass change), and `cobblr_delete_record`, alongside the existing `cobblr_invoke_action` for module operations (adjust stock, mark done, …).
- **Honest by design**: a record kind is creatable/updatable/deletable only where its module declares the route (knowledge entries and tracking metrics do today; more as modules opt in). An undeclared kind gets a clear "can't be updated this way" answer instead of a mystery 404. All writes are permission-checked server-side with your token's own role.

These tools come from the shared `@cobblr/workspace-tools` registry (the same set the in-app Ask Cobb assistant uses) so what your external Claude can do and what Cobb can do never drift apart.
