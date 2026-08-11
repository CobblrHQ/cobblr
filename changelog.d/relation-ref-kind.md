---
type: fix
date: 2026-08-11
scope: fields
---

Creating a relation field now asks which kind of record it points at, and refuses to create one without it. You could previously pick the type but never say what it linked to, so the field stored a reference nothing could resolve and always displayed a raw id.
