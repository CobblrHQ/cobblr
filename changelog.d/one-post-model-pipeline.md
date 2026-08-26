---
type: fix
scope: ai
date: 2026-08-26
---
A bundle reply pasted by hand, and the operator's authoring eval, now go through exactly the same checks as a generated one: fields the kind already has are left out, a request that names nothing builds nothing, and the modules a bundle needs are worked out from what it references. Before, both had their own copy of the pipeline and the checks only ran on the interactive path.
