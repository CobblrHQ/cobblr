---
type: feature
scope: digifab
date: 2026-10-17
docs_target: docs/user-guide/digifab.md#3.19 Digital Fabrication (`digifab`, stock)
---

Every finished print knows what it cost, from the spool it used, with cost per day in Job history

## docs

**What each print cost.** When a print finishes, Cobblr prices it from the spool it used: the grams it took times the spool's price per gram (its **Price / spool** over its starting filament weight, or the filament's **Price per kg** when the spool has no price of its own). A 120 g print from a 1 kg spool bought for 20 costs 2.40. Give a printer, or a whole pool, an **Hour rate** (in the printer's camera and settings panel on its card, or on the pool's row) and its machine time is added too. A print from a spool with no price shows **not priced** and is counted apart, never as free. **Job history** shows the cost of each print, each printer's total, the window's total and a **cost per day** chart under prints per day, and Cobb can answer "what did prints cost this month".
