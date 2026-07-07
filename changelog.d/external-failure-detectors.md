---
type: feature
scope: digifab
date: 2026-07-06
---
Print-failure detection can now use a self-hosted detection service you run anywhere — point it at an Obico ML API or PrintGuard box (or any HTTP model on your LAN) and the spaghetti watch scores prints through it. Pick "External detector" as the backend, add the service's URL + token, and go. Nothing is hardcoded: each service is a small manifest, so new ones drop in without a code change.
