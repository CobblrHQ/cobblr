---
type: selfhost
scope: deploy
date: 2026-08-13
---
Setup writes the generated secrets to a root-only file instead of printing them, and takes a stack directory so one host can run more than one instance without the two fighting over backups.
