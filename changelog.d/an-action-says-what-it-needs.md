---
type: fix
scope: assistant
date: 2026-09-17
---
**The assistant no longer proposes an action it cannot run.** Asking for "turn on provenance" or "rename machines to printers" could produce a card that looked right and failed the moment you pressed it, because the action was called without something it needed. Every action now says which of its details are required, the assistant is told what is missing before a card appears, and pressing a card that would have failed answers with what it needs instead.
