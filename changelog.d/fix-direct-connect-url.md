---
type: fix
---
Connecting a printer by IP no longer creates a broken connection. Typing a bare address like `192.168.1.50` (no `http://`) now gets normalized to a proper URL instead of being saved schemeless — which previously surfaced later as "unreachable — invalid URL" in the fleet. An address that still can't be parsed is rejected up front with a clear message.
