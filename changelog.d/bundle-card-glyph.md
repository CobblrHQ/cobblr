---
type: fix
scope: bundles
date: 2026-07-13
---
Bundle marketplace cards show their own icons again instead of a generic box. The self-hosted registry index fills in a placeholder box glyph for bundles whose icon is a web-only field, and that placeholder was overriding each bundle's real icon on the card. The card now prefers the bundle's authoritative icon over the index placeholder.
