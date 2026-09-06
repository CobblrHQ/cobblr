---
type: internal
date: 2026-09-06
---
The pre-push hook keeps a seconds-long resolution check even when it defers the full typecheck and lint suite on a loaded machine, and a new lint stops a test importing a script that reads a credential on import: two pushes in one afternoon were green locally and red in CI for exactly those reasons.
