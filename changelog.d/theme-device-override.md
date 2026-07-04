---
type: improvement
scope: profile
date: 2026-07-04
---
Theme is now **two separate things**: a **global account default** that syncs to all your devices, and a **per-device lock** that overrides it on just one browser without ever syncing. Profile → Appearance shows both — **Account default** (Match device / Light / Dark) and **This device only** (Use default / Light / Dark) — so you can, say, keep a light default everywhere but force one shared display dark. Precedence is *this device → account default → the device's OS*, and the quick theme toggle in the header now sets **this device only** (toggling back toward your account default releases the lock so the device syncs again). The device override persists locally across reloads; it's never written to your account.
