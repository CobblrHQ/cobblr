---
type: fix
scope: platform
date: 2026-09-13
---
**Deleting a workspace while a request is still using it no longer restarts the api.** A workspace deletion terminates every database connection of that workspace; if one of them was still opening when the deletion landed, the api process exited and every workspace on the instance lost a few seconds to the restart. Every database connection now carries its error handling from the moment it is created, a request that lands mid-deletion gets a clear "this workspace is being deleted" answer instead of a dead connection, and the deletion waits a bounded five seconds for in-flight requests rather than as long as the slowest one.
