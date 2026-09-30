---
type: security
date: 2026-09-29
---
An API token made with another token can no longer outlive or reach beyond the token that made it, and revoking a token now revokes every token made with it. Before, a short-lived token could make itself a permanent one.
