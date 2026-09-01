---
type: fix
scope: core-integrations
date: 2026-09-01
---
Importing from a connected system while its background sync happens to be running no longer fails with a database error. Only one sync of a connection runs at a time now, and if you press Import while one is already going you are told to try again in a moment instead of seeing a failure. The record mapping is also written so that a race can never duplicate or half-land an import.
