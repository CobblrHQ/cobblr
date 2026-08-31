---
type: improvement
scope: platform
date: 2026-08-31
---
Contributors and coding agents can now ask where a new file belongs before writing it, instead of finding out from CI afterwards. `pnpm run where "a sweeper that emails people"` answers with the directory, a real file in the repo to copy the shape from, and the rules that will judge it, each printed from the lint that enforces it so the answer can never be a stale copy. A check keeps the map current: a new rule cannot be added to the repo without saying which kind of work it governs.
