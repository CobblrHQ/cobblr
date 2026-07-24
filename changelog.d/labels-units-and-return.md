---
type: feature
scope: labels
date: 2026-07-24
docs_target: none (updated in-place this PR: USER_GUIDE.md section 3.2 Labels)
---
**Custom label sizes in mm, and a way to un-print a batch.** The New label size dialog now has an **in / mm** toggle, so you can enter metric stock (50 x 30 mm) without converting by hand. It switches in place, keeping the physical size, and remembers your choice. And when a Bluetooth print does not come out right, the toast now offers **Return to queue** instead of a blind reprint: it puts those labels back where they were (reusing their codes) so you can fix the size and try again, rather than reprinting the same thing.
