---
type: improvement
scope: platform
date: 2026-06-18
---
Capture-first onboarding now works **without AI**. When a workspace has no AI provider (free tier, self-host, or offline), the matcher falls back to a deterministic keyword + field-overlap pass — so writing "3 skeins of blue worsted merino wool" still gets identified as Yarn (fiber Wool, weight Worsted, qty 3) and offers to build the tracker, at zero AI cost. Connecting an AI provider only sharpens the identification + field-fill; capture-first never goes dark.
