---
type: fix
scope: dashboard
date: 2026-07-18
---
**Dashboard cards put the important things first.** Three fixes to pinned-view cards and the add panel: a grouped view whose grouping field is unset everywhere (a "by tube type" fleet with no tube types yet) now shows the items themselves with the "set it to group them here" hint as a footer, instead of a hint-only card with nothing in it. The card header stops truncating the names while minor chips stay readable: the redundant view-type label is gone (the card already renders as its type) and the count no longer wraps, so "3D Printers · Printer fleet by state" reads in full. And on an established workspace the "What do you want to do?" panel is a half-width card instead of swallowing a full dashboard row (a blank workspace keeps the full-width hero).
