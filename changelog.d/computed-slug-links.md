---
type: feature
date: 2026-06-25
---
- Computed fields can now build clickable links: a new `{{ name | slug }}` template filter turns a value into a URL-safe slug, and computed fields can use the `url-link` renderer, so e.g. a "git repo" field with template https://github.com/me/{{ name | slug }} renders as a clickable link per entity.
