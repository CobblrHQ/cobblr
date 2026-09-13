---
type: fix
scope: inventory
date: 2026-09-13
---
**Restocking from the shopping list now dates the fresh stock even when the item was created by hand.** A "Good for (days)" typed on the new-item form was being kept as text, so the check-off's fresh lot got no date and the record kept the old Expires while the row had promised a new one. The number is a number now whichever way it is entered, and the row says when something already on hand keeps the earlier date: "1 already on hand, dated 12 Sep, stays first". Once that one is used or thrown out, the fresh lot's date takes over by itself.
