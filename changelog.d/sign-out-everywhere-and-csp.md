---
type: improvement
scope: platform
date: 2026-08-25
---
**Sign out of every other device, and a first Content-Security-Policy.** Your account settings now have a "Sign out everywhere" button that revokes every other signed-in session and keeps only the device you press it on, so a token you no longer trust can be killed without changing your password. The app also began sending a Content-Security-Policy: the parts that cannot break a page (anti-clickjacking, anti-plugin, form and base restrictions) are enforced now, and the stricter script and connection rules ride along in report-only mode so the operator can confirm them against real usage before turning them on.
