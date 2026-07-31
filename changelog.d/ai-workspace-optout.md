---
type: feature
scope: core-ai
date: 2026-07-31
docs_target: none (documented directly in docs/USER_GUIDE.md 3.22 this PR)
---
You can now turn AI off for a single workspace. On Configuration then AI, owners and admins get a "Use AI in this workspace" switch: off, that workspace runs in basic mode and Cobblr makes no AI calls on its behalf, even when the server or your plan has AI available. A member's own personal AI key still works there. The status banner now also says where an "on" workspace's AI comes from (your plan, your personal connection, or a workspace key) so it stops contradicting the "nothing connected" state below it.
