---
type: fix
scope: core-scan
date: 2026-07-14
---
**A burst of edits to the same item no longer risks quietly dropping each other's changes.** Several parts of Cobblr write to a shared bag of details on an item, and a number of those writes were rebuilding the whole bag from a copy they had read a moment earlier, which meant a change made in between could be silently overwritten. Every one of those writes now updates only the specific keys it owns, directly in the database, so concurrent edits to different parts of the same item all survive. This closes out the last of a class of bug that a build check already prevents new instances of.
