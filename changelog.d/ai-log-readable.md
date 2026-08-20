---
type: fix
scope: admin
date: 2026-08-20
---
Long AI calls are readable again in the activity log. A big chat prompt used to be cut off mid-word, which also left the record unparseable, so the pretty view fell back to raw JSON and its Pretty/Raw switch disappeared on exactly the calls that needed it. Oversized records now shorten the long text inside them and keep their shape, the switch is always offered, and a model's reply renders as formatted text instead of showing its asterisks and backticks.
