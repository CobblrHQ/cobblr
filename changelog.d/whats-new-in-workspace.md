---
type: fix
scope: web
date: 2026-07-02
---
"What's new" in the account menu actually goes somewhere now. Inside a workspace the link resolved to a route that didn't exist (the changelog page was only mounted on the signed-out router), so clicking it silently bounced you home. The workspace router now serves the changelog too: same feed, your workspace chrome kept.
