---
type: feature
scope: integrations
date: 2026-06-23
---
Sync connectors now do a proper **one-time import preview** before they touch anything. Enabling an entity type (e.g. companion app locations) no longer writes straight to your workspace — you pull a dry-run plan that shows exactly what *would* happen (create / merge-into-existing / update / unchanged / remove), eyeball it, and approve. The first import even **merges** a source record into a same-name item you already have instead of duplicating it. Once you approve, that entity type switches to live sync (webhook + poll). Live pushes and the background poll stay withheld until the import is approved.
