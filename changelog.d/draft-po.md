---
type: feature
scope: purchases
date: 2026-07-02
---
**Stock that reorders itself.** When a part drops below its minimum, it now lands on a **draft purchase order** for its **usual vendor at its usual quantity** — both learned from the part's own purchase history, zero setup. You review, approve, and the arrival restocks (re-arming the loop). No duplicate drafts while a reorder is in flight; several low parts for one vendor collect on a single draft. Also available as a "Draft a purchase order" button on any part, and it's a plain wire on /bindings — edit or remove it like any other.
