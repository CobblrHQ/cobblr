---
type: feature
scope: core-ai
date: 2026-07-10
docs_target: docs/USER_GUIDE.md#3.22 AI providers & the AI kill-switch (operator)
docs_published: 2026-07-10
---
**You decide what Cobb may touch: right in the chat.** Two toggles now sit at the top of Ask Cobb: **Read my data** (may Cobb search and read this workspace's records to answer you, worth knowing: that record data is sent to the workspace's AI provider, which for a shared AI is another member's connection) and **Propose changes** (may Cobb suggest creates, updates, deletes, and actions, each still needs your Confirm). Both are on by default, per-person per-workspace, and enforced on the server, flipping one off actually withholds those abilities from the model; it doesn't just hide buttons.

## docs

Ask Cobb carries two consent toggles at the top of the panel (per-person, per-workspace, both on by default):

- **Read my data**: whether Cobb may search/list/fetch this workspace's records to answer your questions. When on, matching record data is included in prompts to the workspace's AI provider; with a **shared** AI that means it transits the sharing member's connection. Turn it off and Cobb answers from conversation alone (and says so rather than guessing about your data).
- **Propose changes**: whether Cobb may propose creates, field updates, deletions, and actions. Every proposal still requires your explicit Confirm; this toggle controls whether proposals appear at all. Off, Cobb explains what it *would* do and points you at the toggle.

Both are enforced server-side: the disabled capability's tools are withheld from the model entirely, and the legacy fallback path refuses writes too. Your external Claude over the MCP server is separate. It uses your own token and Claude's own per-tool approval prompts.
