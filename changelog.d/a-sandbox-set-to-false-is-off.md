---
type: selfhost
scope: platform
date: 2026-09-20
---
`COBBLR_TRY_SANDBOX=false` now turns the no-account sandbox off, as the docs always said. It used to turn it ON: the flag was read as a JavaScript boolean, where any non-empty text is true, so the operator careful enough to set it explicitly had anonymous workspaces handed out on their instance. The flag now accepts exactly `true` or `false`; any other value (`1`, `yes`, `off`) refuses to boot and names the value, instead of quietly picking one.
