---
type: improvement
date: 2026-08-25
---

Parcel tracking no longer sleeps through delivery day. A receipt that promised a date now tells the tracker about it, so a parcel due today is checked through the day instead of once at dawn; a parcel out for delivery is re-checked overnight, so the delivered scan is seen by morning instead of a day later; and a tracking bridge can now push "this parcel moved" through an inbound webhook, so updates land minutes after the carrier scans rather than at the next scheduled check. One real laptop was delivered at 7:49pm with nobody told until this; that exact day is now covered three ways.
