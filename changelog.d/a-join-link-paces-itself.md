---
type: feature
scope: auth
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#Inviting others to a workspace
docs_published: 2026-10-01
---
**A join link paces itself.** A wall QR's join link now runs until you revoke it, with a burst guard instead of an end date: 10 joins a day by default (or any number per day, week, month or year). More than that pauses the link and tells the admins, who can **Resume** it or give it a **New code** so the old QR stops working.

## docs

**A join link paces itself.** When you make a join link, **At most, then pause** sets how many may
join per day, week, month or year (10 a day unless you change it). Going past it pauses the link:
nobody new joins, members still get in, and every owner and admin is told. Beside a paused link,
**Resume** turns it back on with the count starting afresh, and **New code** retires the old QR and
opens the print sheet for the new one. A join link has no end date; revoke it to close it.
