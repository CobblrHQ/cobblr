---
type: feature
scope: ai
date: 2026-08-21
docs_target: docs/USER_GUIDE.md#3.22 AI providers & the AI kill-switch (operator)
---
When more than one of your AI connections serves a workspace, you now choose which goes first, and the screen tells you what is already powering it. Before, whichever connection you edited most recently quietly won.

## docs
You can route several of your AI connections to one workspace, and then choose which one goes first. The workspace row on a connection says which of yours is already powering that workspace and offers to put this one first, or to leave the other in front. Before, the connection you had edited most recently quietly won, so renaming or re-keying one could change which model answered in a workspace you had not touched.

Nothing falls through to a second connection when the first errors or hits its daily cap: the call fails and says so, rather than silently spending a different key. The order is recorded per kind of work as well, so a fast model can serve the live camera scan while a slower, better one handles inbox identification and chat.
