---
type: improvement
scope: scan
date: 2026-07-11
---
The scan inbox is harder to disturb by accident. The **merge** control, which folds one scanning session into the previous one, used to sit on the collapsed session header with a down-arrow that was easily mistaken for the expand arrow, and a stray tap mixed unrelated sessions together with no way back. Merge now lives **inside the expanded session** as a plainly-labeled "Merge into the previous session", and every merge shows an **Undo**. Separately, the standalone green "Scan session active" banner no longer repeats the session row it sits above: when the live session is already shown in the list, its **active** dot and **End** control move onto that row instead.
