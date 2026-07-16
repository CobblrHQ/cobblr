---
type: fix
scope: ci
date: 2026-07-16
---
Test workspaces created by a dozen internal tests are now cleaned up properly instead of being left behind, which had been quietly filling the test database with orphaned data.
