---
type: feature
scope: platform
---
One-step **managed-app provisioning**: `POST /orgs/provision-app` creates a workspace, installs the app's flagship bundle, and locks it into app mode in a single call — the server-side foundation for a seamless "Cobblr for Yarn" signup. (The bundle-apply is now a shared, reusable function behind both this and bundle install.)
