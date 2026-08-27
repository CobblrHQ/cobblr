---
type: improvement
scope: core-integrations
date: 2026-08-27
---
A sync-source manifest can now read a foreign key that the source sends as a link. Writing `$.parent|last` takes the last segment of a value like `/api/storage_locations/1`, so an API that expresses relations as URLs (API Platform, Django REST hyperlinked serializers, JSON:API) can feed the engine's parent and cross-section references without a code change. A manifest that misspells the operator is rejected when it is saved rather than silently importing a flat tree.
