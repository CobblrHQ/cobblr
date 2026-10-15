---
type: feature
scope: ai
date: 2026-10-15
docs_target: docs/USER_GUIDE.md#Reading a personal document
---
A model on your own computer, reached through an updated edge bridge, can now read personal documents. The read never follows a redirect off that computer and is never written to Cobblr's database or the bridge's disk; an older bridge is still refused.

## docs

**A local model through your edge bridge.** If the model that reads personal documents runs on your own computer (Ollama, or a local OpenAI-style server) and Cobblr reaches it through your edge bridge, an up-to-date bridge can carry the read. It goes straight to that model and nowhere else: a redirect to another address is refused, the document is never saved to the bridge's disk, and Cobblr never writes it to its database. A bridge that has not updated yet is refused, and the document is read by code on this machine until it updates (bridges update themselves within about half an hour).
