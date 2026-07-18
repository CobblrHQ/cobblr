---
type: feature
scope: platform
date: 2026-07-18
docs_target: none (operator token scope, surfaced in the token mint UI itself)
---
A new "Re-home a collection onto Records" API token scope lets an operator run that one data move without holding a full-admin token. Like the other capability scopes, it is deny-by-default: a token minted with it can call the re-home operation and nothing else, not tenant data, not workspace deletion, not minting another token.
