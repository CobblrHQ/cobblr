---
type: improvement
scope: platform
date: 2026-08-07
---
Cobblr now upgrades its own database across major PostgreSQL versions. Previously a new major refused to start on an existing data directory, so someone had to stop the stack, export everything, wipe it and import again, which is not something a self-hosted instance should ever be asked to do. The database image now carries the previous version too and migrates the data itself on first start, keeping the old copy untouched as a fallback, so pulling a new image is all an instance has to do. This release moves to PostgreSQL 18.
