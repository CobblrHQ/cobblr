---
type: fix
date: 2026-08-17
---

Ask Cobb can now make the changes you have already allowed, on workspaces whose
AI runs through a Claude subscription connection. Before, Cobb offered to create
and update records there but every attempt was refused, and the explanation
pointed at a connector permission that does not exist. Cobb now only offers what
it can actually do: with Changes set to Auto it creates, updates and deletes
records directly (each one still tracked and undoable), and with Changes set to
Ask or Off it says so plainly and points at the setting instead.
