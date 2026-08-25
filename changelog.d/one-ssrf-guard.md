---
type: fix
scope: platform
date: 2026-08-25
---
**Every outbound fetch of a user-supplied address now checks the same block list.** The rule for "this address is internal, never fetch it" had drifted into several copies that disagreed about which ranges counted, so a hostname that resolved to a private range could be blocked on one path and allowed on another. There is now one shared rule that every guard uses, covering the private, loopback, carrier-grade-NAT and metadata ranges in both IPv4 and IPv6. An externally sourced image URL is now resolved and checked before it is fetched, instead of only inspecting a literal IP. A lint keeps it a single rule so a new copy cannot drift again.
