---
type: feature
scope: libraries
date: 2026-10-04
docs_target: none (adapter author contract; existing library setup stays the same)
---
Libraries from other modules can now show their own webhook setup and match items from their notifications.

## docs

Adapters declare their library webhook setup and reference extraction recipe in connection metadata. Services exposes this metadata by adapter group. The library consumer reads it without importing the adapter's module, and webhook matching reads each item back through its originating group. The recipes contain only data, so they can cross a sandbox boundary as JSON.
