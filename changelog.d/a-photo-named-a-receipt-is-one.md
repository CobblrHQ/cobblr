---
type: fix
scope: scan
date: 2026-09-04
---
A photographed receipt that the identify pass names as a receipt is now read as one, whatever else its description says. It could be named "Walmart printed receipt" and still be filed as a product, because the check read the description first and stopped there; on the hosted path the description can be empty, so the name was the only signal and the one never looked at.
