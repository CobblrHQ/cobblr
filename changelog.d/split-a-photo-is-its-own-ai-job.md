---
type: feature
scope: core-scan
date: 2026-09-04
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Splitting a group photo into separate items is now its own AI job. Under Configuration, AI it appears as "Split a photo into items" with its own provider and model choice, so it can run on a cheaper model than identification, and its usage shows on its own line instead of inside the identify count. Nothing changes about how splitting works from the inbox.

## docs

Splitting one photo of several things into separate inbox items is its own job on the AI page, "Split a photo into items", separate from identifying a single item. Point it at any provider or routed connection and pick a model, the same as the other jobs; leave it alone and it runs on whatever the workspace would otherwise use. Its calls are counted on their own line in AI activity.
