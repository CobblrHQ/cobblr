---
type: fix
scope: deploy
date: 2026-08-14
---
A blank line in .env no longer stops the instance from starting: an empty value now means "not set", which is what docker-compose passes for an unset variable.
