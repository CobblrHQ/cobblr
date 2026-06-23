---
type: feature
scope: labels
date: 2026-06-23
---
QR labels can now encode a **self-describing** URL — `/qr/<kind>/<id>` instead of an opaque random token. The win: a scanned code stays meaningful even if this Cobblr instance is ever gone or moved (you can read what it points at straight off the URL, and it survives route changes), where an opaque token is a dead pointer without the database. It's the new default; flip a workspace to **opaque** (shorter, reveals nothing, scans better on tiny labels) on the QR codes page. Both styles resolve identically and anything you've already printed keeps working.

(Descriptive applies to plain navigate labels — action-trigger and expiring QR codes always get a distinct opaque token, since a single `/qr/<kind>/<id>` can only mean one thing.)
