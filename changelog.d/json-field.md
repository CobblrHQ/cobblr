---
type: feature
scope: web
date: 2026-06-24
---
Structured-JSON inputs now go through one shared, validated control instead of a dozen ad-hoc textareas. Wherever you paste a JSON blob: connector credentials, a vendor-resolver manifest, and (incrementally) view configs, app schemas, channel configs; you get live parse errors, "Format" pretty-printing, and inline JSON-Schema validation that points at exactly which field is wrong. Sync connections gained a "paste JSON →" toggle for credentials; the scan vendor-resolver editor now validates as you type.
