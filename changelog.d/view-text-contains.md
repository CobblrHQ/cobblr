---
type: improvement
scope: views
date: 2026-10-16
---

**A saved view can look for words.** In a view's filters, a text field now offers **contains** and **does not contain**: *notes contain warranty* finds "Warranty until 2027" and "kept the WARRANTY card", ignoring case, and what you type is matched exactly, a `%` or `_` included. **Does not contain** also keeps the records with nothing written there. Cobb can filter the same way when you ask ("which tools mention a warranty?"), and a collection that cannot filter by text says so instead of showing everything. On a phone, a filter's value box now wraps onto its own line instead of running off the screen.
