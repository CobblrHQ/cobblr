---
type: fix
scope: platform
date: 2026-08-25
---
**The image fetch now pins its connection to the address it checked.** Fetching an externally sourced image already followed redirects itself and re-checked every hop against the internal-address block list; it now also pins each hop's connection to the exact address that passed the check, so a hostname that changes what it resolves to between the check and the connection cannot slip an internal address through. This closes the last narrow gap in that path and brings it in line with the platform's other outbound fetches.
