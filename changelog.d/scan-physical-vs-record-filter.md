---
type: fix
---
A scanned physical product no longer gets suggested for admin tables it can't belong to. Scanning a barcode (or a photo the AI reads as an item) will never route to Subscriptions, Warranties, Documents, or Bills — those are records you add by hand, not by scanning. Scannable physical tables like Medications and Collections are unaffected. The guard is deterministic, so it holds even when AI is slow or offline.
